# API Reference

Base path: `/api/v1`

All requests and responses are JSON. Dates are `YYYY-MM-DD` throughout — no
timezone, no ambiguity between `03/04/2020` readings.

---

## Employee record

| Field | Type | Notes |
|---|---|---|
| `id` | integer | Assigned by the database, read-only |
| `name` | string | 1–120 characters, trimmed |
| `dob` | date | `YYYY-MM-DD`, in the past, implies an age under 120 |
| `designation` | string | 1–120 characters, trimmed |
| `doj` | date | `YYYY-MM-DD`, after `dob`, at most one year ahead |
| `created_at` | timestamp | Read-only |
| `updated_at` | timestamp | Read-only, maintained by a database trigger |

```json
{
  "id": 1,
  "name": "Ada Lovelace",
  "dob": "1990-12-10",
  "designation": "Principal Engineer",
  "doj": "2015-06-01",
  "created_at": "2026-09-14T09:29:06.480Z",
  "updated_at": "2026-09-14T09:29:06.480Z"
}
```

Every rule above is enforced twice: by the API (a clear 400 naming the field)
and by `CHECK` constraints in PostgreSQL (so anything reaching the database by
another route is still rejected).

---

## Endpoints

### `GET /api/v1`

Service and build information. Use it to confirm what is actually running.

```json
{
  "service": "employee-api",
  "version": "b39edf5",
  "commit": "b39edf5a1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f",
  "endpoints": ["GET    /api/v1/employees", "..."]
}
```

---

### `GET /api/v1/employees`

List employees, paginated.

| Query | Type | Default | Notes |
|---|---|---|---|
| `limit` | integer | `50` | 1–200 |
| `offset` | integer | `0` | |
| `search` | string | — | Case-insensitive substring of name **or** designation |
| `sort` | enum | `id` | `id`, `name`, `dob`, `doj` — allow-listed |
| `order` | enum | `asc` | `asc`, `desc` |

```bash
curl 'http://localhost:3080/api/v1/employees?limit=10&sort=doj&order=desc'
curl 'http://localhost:3080/api/v1/employees?search=engineer'
```

**200**

```json
{
  "data": [ { "id": 1, "name": "Ada Lovelace", "...": "..." } ],
  "pagination": { "total": 42, "limit": 10, "offset": 0, "hasMore": true }
}
```

`sort` is validated against a fixed list because a column name cannot be a bound
parameter — an unchecked value here would be an SQL injection point.

---

### `GET /api/v1/employees/{id}`

```bash
curl http://localhost:3080/api/v1/employees/1
```

**200** `{ "data": { ... } }` · **404** not found · **400** id is not a positive integer

---

### `POST /api/v1/employees`

```bash
curl -X POST http://localhost:3080/api/v1/employees \
  -H 'Content-Type: application/json' \
  -d '{
        "name": "Ada Lovelace",
        "dob": "1990-12-10",
        "designation": "Principal Engineer",
        "doj": "2015-06-01"
      }'
```

**201** with a `Location: /api/v1/employees/1` header and the created record.

All four fields are required. Unknown fields are **rejected**, not ignored — a
typo like `desgination` should be an error, not a record silently saved without
a designation.

---

### `PUT /api/v1/employees/{id}`

Full replacement; send every field.

```bash
curl -X PUT http://localhost:3080/api/v1/employees/1 \
  -H 'Content-Type: application/json' \
  -d '{"name":"Ada Lovelace","dob":"1990-12-10","designation":"Distinguished Engineer","doj":"2015-06-01"}'
```

**200** updated record · **404** not found · **400** validation failed

---

### `DELETE /api/v1/employees/{id}`

```bash
curl -X DELETE http://localhost:3080/api/v1/employees/1
```

**204** no content · **404** not found

---

## Health

| Endpoint | Purpose | Checks the database? |
|---|---|---|
| `GET /healthz` | Liveness | **No** — deliberately |
| `GET /readyz` | Readiness | Yes |
| `GET /startupz` | Startup | No |

```json
GET /readyz  ->  200 {"status":"ready","checks":{"database":"ok"}}
             ->  503 {"status":"not_ready","checks":{"database":"unreachable"}}
             ->  503 {"status":"shutting_down"}
```

Liveness avoids the database on purpose: if Postgres is down, restarting API
pods does not fix anything and converts an outage into a CrashLoopBackOff.

---

## Metrics

`GET /metrics` on port **9090** — a different port from the API, and not routed
through the Istio Gateway. Requesting `/metrics` on the API port returns 404.

---

## Errors

Every error has the same shape:

```json
{
  "error": {
    "code": "bad_request",
    "message": "The request body is not valid.",
    "details": [
      { "field": "dob", "message": "must be a date in YYYY-MM-DD format" }
    ],
    "requestId": "87b57a48-6a15-4516-b273-4f6b6d6b9f19"
  }
}
```

`requestId` is echoed in the `x-request-id` response header and appears in the
structured logs, so a user-reported failure can be found directly. If Istio set
the header, that value is reused so the request can be traced across the mesh.

| Status | `code` | Meaning |
|---|---|---|
| 400 | `bad_request` | Validation failed — see `details` |
| 404 | `not_found` | No such record or route |
| 409 | `conflict` | Unique or foreign-key violation |
| 413 | `payload_too_large` | Body over 100 kB |
| 429 | `rate_limited` | Too many requests |
| 500 | `internal_error` | Unexpected — details are in the logs, not the response |
| 503 | `database_unavailable` / `timeout` | Database unreachable or too slow |

Raw PostgreSQL errors are never returned: driver messages leak table names,
column names and constraint definitions. They are logged and mapped to the
statuses above.

### Validation messages

| Input | Response |
|---|---|
| `"dob": "10/12/1990"` | `dob: must be a date in YYYY-MM-DD format` |
| `"dob": "2023-02-30"` | `dob: is not a real calendar date` |
| `"dob"` in the future | `dob: must be in the past` |
| `"doj"` before `dob` | `doj: must be after the date of birth` |
| `"name": "   "` | `name: is required` |
| `"salary": 100000` | `bad_request` — unknown field |

---

## Rate limiting

Applies to `/api` only — health probes are never rate limited, or they would
fail under load and the pod would be restarted exactly when it is busiest.

Defaults to 120 requests per minute per client IP. Responses carry draft-7
headers:

```
RateLimit-Policy: 120;w=60
RateLimit: limit=120, remaining=118, reset=42
```

Behind Istio the client IP comes from `X-Forwarded-For`; the app trusts exactly
one proxy hop, so a client cannot spoof it to evade the limit.

---

## Security headers

Set on every response by Helmet, and again at the Istio VirtualService:

```
Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; ...
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: no-referrer
Strict-Transport-Security: max-age=31536000; includeSubDomains   (production)
```

`X-Powered-By` is removed.
