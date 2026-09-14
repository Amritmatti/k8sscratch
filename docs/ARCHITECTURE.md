# Architecture

How the pieces fit together, and why each decision was made. Where a choice has
a real downside, it is stated.

---

## Request path

```
client
  │  HTTP
  ▼
Istio Ingress Gateway            (istio-system)
  │  matches Gateway + VirtualService
  │  retries connect-failure, 15s timeout
  ▼
Envoy sidecar                    (mTLS STRICT, AuthorizationPolicy)
  │
  ▼
employee-api container :3000
  │  pg connection pool
  ▼
Envoy sidecar ──▶ postgresql :5432   (NetworkPolicy: only API pods)
```

---

## Components

| Component | Choice | Why |
|---|---|---|
| Runtime | Node.js 22 on Alpine | Small image, LTS |
| Framework | Express 4 | Boring, stable, well understood |
| Database | PostgreSQL 16 | Real constraints, real types, real transactions |
| Driver | `pg` | No ORM — the queries here are simple and explicit SQL is easier to audit for injection |
| Validation | Zod | Schemas that mirror the database constraints |
| Logging | Pino | Structured JSON, redaction built in |
| Metrics | prom-client | Prometheus is the default in Kubernetes |
| Packaging | Helm 3 | Asked for; templating plus release lifecycle |
| Ingress | Istio Gateway | Asked for; brings mTLS and authorization with it |

---

## Decisions

### Migrations run in an initContainer, not a Helm pre-install hook

**The problem with the obvious approach.** A `pre-install` hook Job seems right,
but Helm runs pre-install hooks *before* the chart's normal resources. The
PostgreSQL StatefulSet is a normal resource. So on a fresh install the migration
Job would start, wait for a database that has not been created yet, and time
out. This was caught by walking the install ordering, not by `helm template`,
which does not run hooks.

**What is done instead.** Every API pod runs migrations in an initContainer.
That is correct in all orderings: on a fresh install the pod simply waits for
the database being created alongside it, and no pod can ever serve traffic
against an un-migrated schema.

Safe with multiple replicas because the runner:

- takes a Postgres **advisory lock**, so exactly one pod migrates and the others
  wait, then find nothing to do;
- records applied migrations in `schema_migrations` with a **checksum**;
- **refuses to run** if an already-applied file has changed, because that means
  environments have silently diverged.

The `hook` strategy is still available (`migrations.strategy: hook`) for teams
who want a bad migration to fail the Helm release itself. It is wired as
`post-install,pre-upgrade` — never `pre-install`.

**Downside:** a failed migration surfaces as a pod stuck in `Init:Error` rather
than a clean `helm upgrade` failure.

### Liveness does not check the database

If liveness checked Postgres and Postgres went down, Kubernetes would restart
every API pod — turning a database outage into a CrashLoopBackOff, with pods
coming back no healthier than they left, and the restart storm making recovery
harder.

Readiness checks it instead: pods leave the Service, stop receiving traffic,
stay alive, and rejoin automatically when the database returns.

### Frames of shutdown

Endpoint removal in Kubernetes is asynchronous — traffic keeps arriving for a
second or two after a pod is marked `Terminating`. So:

1. `SIGTERM` arrives; the app immediately fails `/readyz`.
2. It keeps serving for `PRE_STOP_DELAY_MS` (5s) while endpoints propagate.
3. It stops accepting new connections and lets in-flight requests finish, up to
   `SHUTDOWN_TIMEOUT_MS` (10s).
4. The pool closes, the process exits.

`terminationGracePeriodSeconds: 45` is comfortably above 5 + 10. A `preStop`
hook adds the same pause at the container level.

### Metrics on a separate port

Port 9090, not 3000. The Service exposes both, but only 3000 is routed through
the Gateway, and the AuthorizationPolicy restricts 9090 to the monitoring
namespaces. Request rates, latencies and record counts are operational data.

### Route labels, not URL labels

`employee_api_http_requests_total` is labelled with the matched Express route
(`/api/v1/employees/:id`). Labelling by raw URL would create a new time series
per employee id — unbounded cardinality is the standard way to take Prometheus
down.

### Dates as strings

The `pg` driver returns `DATE` columns as JavaScript `Date` objects in the
server's timezone, which shifts a date of birth by a day either side of UTC.
A type parser keeps them as the literal `YYYY-MM-DD`. Employee records only ever
need the calendar date. An integration test asserts the round trip.

### Sort column allow-list

Bound parameters cannot be used for identifiers, so `ORDER BY ${input}` would be
an injection point regardless of parameterisation elsewhere. `sort` is validated
against `{id, name, dob, doj}` and mapped to a fixed SQL fragment. A unit test
asserts `id; DROP TABLE employees` is rejected.

### `.strict()` on input schemas

An unknown field is an error, not something to ignore. A typo like
`desgination` should fail loudly rather than silently save a record without a
designation.

### No CPU limit

Requests are set, memory is limited, CPU is not. CPU limits cause CFS
throttling, which shows up as unexplained tail latency. Memory is limited
because it is incompressible — without a limit one pod can take down a node.
The value is commented in `values.yaml` for platforms that mandate one.

### Database not in the mesh

`sidecar.istio.io/inject: "false"` on the StatefulSet. An Envoy in front of a
StatefulSet complicates startup ordering for no real benefit here, and the
NetworkPolicy already restricts who can reach 5432.

Same for the migration Job and the Helm test Pod, for a different reason: an
Istio sidecar keeps running after the main container exits, so the pod never
reaches `Completed` and the hook hangs.

### Port names matter to Istio

Istio routes on the port **name** prefix:

- `http-api`, `http-metrics` → HTTP-aware routing, telemetry, policy
- `tcp-postgresql` → opaque TCP

Naming the Postgres port `http-` would make the sidecar try to parse the
Postgres wire protocol as HTTP and drop the connection.

### `holdApplicationUntilProxyStarts`

Without it, the app container can start and open its first outbound connection
before Envoy is listening — so the initial database connection fails. The
annotation makes the app wait for the sidecar.

---

## Data model

```sql
CREATE TABLE employees (
    id           INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name         TEXT        NOT NULL,
    dob          DATE        NOT NULL,
    designation  TEXT        NOT NULL,
    doj          DATE        NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    ...CHECK constraints...
);
```

Indexes on `lower(name)`, `lower(designation)` and `doj DESC` — matching the
search (case-insensitive `LIKE`) and default sort. `updated_at` is maintained by
a trigger rather than trusting the application to set it.

`id` is a sequential integer because the brief lists `ID` as a field. Sequential
ids are enumerable; if the API is ever exposed to untrusted clients, a UUID or a
separate public identifier would be better.

---

## Scaling

**API** — stateless, so horizontal scaling is straightforward. The HPA
(prod overlay) targets 70% CPU, 3–12 replicas, with a 300s scale-down
stabilisation window: scaling in during a dip and straight back out is worse
than holding a spare pod.

Watch the connection maths: `DB_POOL_MAX` (10) × replicas. At 12 replicas that
is 120 connections, and PostgreSQL's default `max_connections` is 100. Either
lower the pool or put PgBouncer in front.

**Database** — vertical only, as bundled. The StatefulSet is one replica with no
failover. For production, `postgresql.enabled: false` and a managed service or
CloudNativePG.

---

## Failure behaviour

| Failure | What happens |
|---|---|
| One API pod dies | Deployment replaces it; PDB and anti-affinity keep others serving |
| Database down | Readiness fails, pods leave the Service but stay alive; `/healthz` still passes so they are not restarted; they rejoin when it returns |
| Migration fails | `Init:Error`, the pod never serves; existing pods keep running the old version |
| Bad image tag | `ImagePullBackOff`; the rollout stalls with `maxUnavailable: 0`, so old pods keep serving |
| Node drain | PDB keeps `minAvailable` pods up; `preStop` + graceful shutdown avoid dropped requests |
| Pod returns 5xx repeatedly | Istio outlier detection ejects it from the load balancing pool before readiness notices |

---

## What is deliberately not here

- **Authentication.** Not in the brief. Significant for personal data — see
  [SECURITY.md](SECURITY.md#known-limitations).
- **An ORM.** The queries are simple; explicit SQL is easier to audit.
- **A service mesh for the database.** Complexity without benefit at this size.
- **Multi-region, read replicas, caching.** No requirement stated, and each adds
  real operational cost.
- **Image signing.** Worth adding with Cosign and a Kyverno policy if you need
  provenance enforced at admission.
