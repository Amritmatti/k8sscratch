# Running locally

Two ways to run the API without Kubernetes. Docker Compose is the one to use —
it runs the same image the cluster runs.

---

## Option 1: Docker Compose (recommended)

```bash
docker compose up --build -d
```

That starts three things in order:

1. **`postgres`** — PostgreSQL 16, waits until it genuinely accepts queries
   (the healthcheck runs `SELECT 1`, because `pg_isready` returns success
   slightly before the database is usable).
2. **`migrate`** — applies `app/migrations/*.sql`, then exits.
3. **`api`** — starts only once the database is healthy *and* migrations have
   completed successfully.

### Endpoints

| | URL |
|---|---|
| API | <http://127.0.0.1:3080/api/v1/employees> |
| Liveness | <http://127.0.0.1:3080/healthz> |
| Readiness | <http://127.0.0.1:3080/readyz> |
| Metrics | <http://127.0.0.1:9091/metrics> |
| PostgreSQL | `127.0.0.1:55432` |

Host ports default to **3080 / 9091 / 55432** rather than 3000 / 9090 / 5432,
which are commonly already in use. Override them:

```bash
API_PORT=8000 METRICS_HOST_PORT=9100 POSTGRES_PORT=5555 docker compose up -d
```

### Everyday commands

```bash
docker compose logs -f api           # follow application logs
docker compose logs migrate          # what the migration did
docker compose ps                    # health status of each service
docker compose restart api           # restart just the API
docker compose run --rm migrate      # re-run migrations (idempotent)
docker compose down                  # stop, keep the data
docker compose down -v               # stop and delete the database volume
```

### Try it

```bash
# Create
curl -X POST http://127.0.0.1:3080/api/v1/employees \
  -H 'Content-Type: application/json' \
  -d '{"name":"Ada Lovelace","dob":"1990-12-10","designation":"Principal Engineer","doj":"2015-06-01"}'

# List, search, sort
curl 'http://127.0.0.1:3080/api/v1/employees?limit=10&sort=doj&order=desc'
curl 'http://127.0.0.1:3080/api/v1/employees?search=engineer'

# Read, update, delete
curl http://127.0.0.1:3080/api/v1/employees/1
curl -X PUT http://127.0.0.1:3080/api/v1/employees/1 \
  -H 'Content-Type: application/json' \
  -d '{"name":"Ada Lovelace","dob":"1990-12-10","designation":"Distinguished Engineer","doj":"2015-06-01"}'
curl -X DELETE http://127.0.0.1:3080/api/v1/employees/1
```

Or run the whole flow in one go:

```bash
make verify
```
```powershell
.\scripts\task.ps1 verify
```

The local container mirrors the Kubernetes `securityContext` — read-only root
filesystem, all capabilities dropped, `no-new-privileges`, non-root user — so a
permission problem shows up here rather than for the first time in the cluster.

---

## Option 2: Node directly

Useful when you want a debugger attached or a fast edit-reload loop.

```bash
cd app
npm install

docker compose up -d postgres         # just the database

export DB_HOST=127.0.0.1 DB_PORT=55432 DB_NAME=employees \
       DB_USER=employee_app DB_PASSWORD=local-dev-password

npm run migrate                        # apply the schema
npm run dev                            # node --watch, restarts on save
```

On Windows PowerShell:

```powershell
$env:DB_HOST='127.0.0.1'; $env:DB_PORT='55432'; $env:DB_NAME='employees'
$env:DB_USER='employee_app'; $env:DB_PASSWORD='local-dev-password'
npm run migrate
npm run dev
```

`app/.env.example` lists every variable the app reads. Copy it to `app/.env`
for reference — note the app itself does not load `.env`; export the variables
or use Compose.

---

## Tests

```bash
npm run test:unit          # 22 tests, no database required
npm run test:integration    # 13 tests, needs Postgres
npm test                    # both
```

Integration tests need connection details:

```bash
cd app
DB_HOST=127.0.0.1 DB_PORT=55432 DB_NAME=employees \
DB_USER=employee_app DB_PASSWORD=local-dev-password LOG_LEVEL=silent \
npm run test:integration
```

or `make test-integration` / `.\scripts\task.ps1 test-integration`.

Without a reachable database the integration suite **skips** rather than fails,
so `npm test` still works on a machine with no Docker. It prints how to start
one.

### What the tests cover

**Unit** (`tests/unit.test.js`) — validation only, so they are fast and need
nothing running. Notably they assert that the sort parameter is rejected unless
it is on the allow-list, which is what stops `ORDER BY` becoming an injection
point.

**Integration** (`tests/integration.test.js`) — the full HTTP surface against
real Postgres: CRUD, pagination, search, error shapes, and two tests that write
directly to the database to prove the `CHECK` constraints reject bad data even
when the API layer is bypassed.

---

## Configuration

All configuration is environment variables. In Kubernetes the non-secret ones
come from a ConfigMap and the credentials from a Secret; both are defined in
`charts/employee-api/values.yaml`.

| Variable | Default | Notes |
|---|---|---|
| `NODE_ENV` | `development` | `production` enables required-secret checks |
| `PORT` | `3000` | API port |
| `METRICS_PORT` | `9090` | Separate, so metrics never route through the gateway |
| `LOG_LEVEL` | `debug` / `info` | `silent` in tests |
| `LOG_PRETTY` | `true` in dev | JSON when false |
| `DB_HOST` / `DB_PORT` | `localhost` / `5432` | |
| `DB_NAME` / `DB_USER` / `DB_PASSWORD` | | Required when `NODE_ENV=production` |
| `DB_SSL` | `false` | `true` for a managed database |
| `DB_POOL_MAX` | `10` | Connections per pod — multiply by replica count |
| `DB_STATEMENT_TIMEOUT_MS` | `10000` | Stops a runaway query holding a pool slot |
| `RATE_LIMIT_MAX` | `120` | Per window, per client IP |
| `SHUTDOWN_TIMEOUT_MS` | `10000` | Grace period for in-flight requests |
| `PRE_STOP_DELAY_MS` | `5000` | Keep serving after readiness starts failing |

With `NODE_ENV=production` the process **refuses to start** if `DB_HOST`,
`DB_NAME`, `DB_USER` or `DB_PASSWORD` is missing. A service that starts
silently with the wrong database is worse than one that fails loudly.

---

## Health endpoints

The split between them is deliberate and matters in a cluster:

| Endpoint | Checks | Used as |
|---|---|---|
| `/healthz` | Event loop responsive. **Nothing else.** | Liveness |
| `/readyz` | Database reachable; fails during shutdown | Readiness |
| `/startupz` | Boot finished | Startup |

Liveness deliberately does not touch the database. If Postgres goes down and
liveness checked it, Kubernetes would restart every API pod — turning a database
outage into a CrashLoopBackOff, with pods coming back no healthier than they
left. Readiness checking it is correct: pods leave the Service and stop
receiving traffic, stay alive, and rejoin when the database returns.

---

## Metrics

Prometheus format on port 9090 (host 9091 under Compose):

```bash
curl -s http://127.0.0.1:9091/metrics | grep employee_api_
```

| Metric | Type | |
|---|---|---|
| `employee_api_http_request_duration_seconds` | Histogram | By method, route, status |
| `employee_api_http_requests_total` | Counter | By method, route, status |
| `employee_api_db_up` | Gauge | 1 / 0 |
| `employee_api_employees_total` | Gauge | Row count, refreshed on scrape |

Route labels use the matched Express route (`/api/v1/employees/:id`), not the
raw URL — labelling by raw path would create a new time series per employee id
and eventually take Prometheus down.

The metrics port is **not** exposed through the Istio Gateway, and the
`AuthorizationPolicy` only permits scraping from the monitoring namespaces.
Request rates, latencies and record counts are operational data.
