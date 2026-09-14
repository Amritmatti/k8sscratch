# Employee API — DevOps / DevSecOps Reference Project

A Node.js REST API storing employee records in PostgreSQL, deployed to
Kubernetes with Helm, exposed through an Istio ingress gateway, and built by
GitHub Actions into a Docker Hub image tagged with the commit hash.

**Record fields:** `ID`, `Name`, `DOB`, `Designation`, `DOJ`.

```
                    ┌──────────────────────────────────────────┐
  client ──────────▶│  Istio Ingress Gateway (istio-system)    │
                    └───────────────────┬──────────────────────┘
                                        │  Gateway + VirtualService
                    ╔═══════════════════▼══════════════════════╗
                    ║  namespace: employee-app                 ║
                    ║  istio-injection=enabled                 ║
                    ║  PodSecurity: restricted                 ║
                    ║                                          ║
                    ║   ┌────────────────┐   mTLS STRICT       ║
                    ║   │ employee-api   │◀────────────────┐   ║
                    ║   │ Deployment x2  │                 │   ║
                    ║   │  ├ initC:      │                 │   ║
                    ║   │  │  migrate    │                 │   ║
                    ║   │  ├ api :3000   │─── NetworkPolicy┼─┐ ║
                    ║   │  └ envoy       │                 │ │ ║
                    ║   └────────────────┘                 │ │ ║
                    ║                                      │ │ ║
                    ║   ┌────────────────┐                 │ │ ║
                    ║   │ postgresql     │◀────────────────┘ │ ║
                    ║   │ StatefulSet    │   only API pods ──┘ ║
                    ║   │  + PVC 8Gi     │                     ║
                    ║   └────────────────┘                     ║
                    ╚══════════════════════════════════════════╝
```

---

## Quick start

### 1. Run it locally (no Kubernetes needed)

```bash
git clone <this-repo> && cd k8sscratch

docker compose up --build -d          # Postgres, migrations, then the API
curl http://127.0.0.1:3080/readyz     # {"status":"ready",...}
```

Create a record:

```bash
curl -X POST http://127.0.0.1:3080/api/v1/employees \
  -H 'Content-Type: application/json' \
  -d '{"name":"Ada Lovelace","dob":"1990-12-10","designation":"Principal Engineer","doj":"2015-06-01"}'
```

### 2. Deploy to Kubernetes

```bash
# 1. Istio first — the chart needs its CRDs
./scripts/install-istio.sh

# 2. Then the app.
#    --namespace, NOT --create-namespace: the chart renders its own Namespace
#    so it can apply the istio-injection and PodSecurity labels.
helm upgrade --install employee-api ./charts/employee-api \
  --namespace employee-app \
  --set image.repository=YOUR_DOCKERHUB_USERNAME/employee-api \
  --set image.tag=$(git rev-parse --short=7 HEAD) \
  --set secrets.dbPassword="$(openssl rand -base64 24)" \
  --set secrets.postgresPassword="$(openssl rand -base64 24)" \
  --wait

helm test employee-api -n employee-app
```

Don't want the mesh? `--set istio.enabled=false` and reach the API with
`kubectl port-forward`.

Full walkthrough, including installing Istio and getting a cluster:
**[docs/DEPLOY.md](docs/DEPLOY.md)**.

---

## Documentation

| Document | What it covers |
|---|---|
| **[docs/BUILD.md](docs/BUILD.md)** | Building the image, the CI pipeline, Docker Hub setup |
| **[docs/RUN.md](docs/RUN.md)** | Running locally with Compose or bare Node, running tests |
| **[docs/DEPLOY.md](docs/DEPLOY.md)** | Getting a cluster, installing Istio, Helm deploy, upgrade, rollback |
| **[docs/API.md](docs/API.md)** | Endpoint reference with request and response examples |
| **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** | How it is put together and why |
| **[docs/SECURITY.md](docs/SECURITY.md)** | The DevSecOps controls and what each one actually stops |
| **[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)** | Symptoms, causes, fixes |

---

## Task runner

Both wrappers call the same commands — use whichever suits your shell.

```bash
make help                 # Linux / macOS / WSL
```
```powershell
.\scripts\task.ps1 help   # Windows
```

Common tasks:

| Task | Does |
|---|---|
| `dev` | Start Postgres + migrations + API locally |
| `verify` | Exercise the local API end to end |
| `test` | Unit tests (no database needed) |
| `test-integration` | Integration tests against the local database |
| `build` | Build the image tagged with the commit hash |
| `lint` | `helm lint` against every values file |
| `template` | Render the manifests to stdout |
| `deploy` | `helm upgrade --install` |
| `smoke` | `helm test` against the release |
| `logs` | Follow application logs in the cluster |
| `rollback` | Roll back to the previous revision |

---

## Layout

```
k8sscratch/
├── app/                          Node.js application
│   ├── src/
│   │   ├── config.js             env -> config, fails fast if misconfigured
│   │   ├── app.js                Express wiring
│   │   ├── server.js             bootstrap, graceful shutdown
│   │   ├── validation.js         Zod schemas (mirror the DB constraints)
│   │   ├── metrics.js            Prometheus, on a separate port
│   │   ├── db/
│   │   │   ├── pool.js           connection pool
│   │   │   ├── employees.js      data access (parameterised, allow-listed sort)
│   │   │   └── migrate.js        idempotent migration runner
│   │   ├── routes/               employees, health
│   │   └── middleware/errors.js  error -> HTTP mapping
│   ├── migrations/001_init.sql   schema + CHECK constraints
│   ├── tests/                    22 unit, 13 integration
│   └── Dockerfile                multi-stage, non-root, read-only rootfs
│
├── charts/employee-api/          Helm chart
│   ├── values.yaml               ALL config and secrets
│   ├── values-dev.yaml           dev overlay
│   ├── values-prod.yaml          prod overlay (external DB, HPA, TLS)
│   └── templates/
│       ├── namespace.yaml        istio-injection + PodSecurity restricted
│       ├── deployment.yaml       API + migration initContainer
│       ├── postgresql.yaml       StatefulSet + PVC + Services
│       ├── istio-*.yaml          Gateway, VirtualService, DestinationRule,
│       │                         PeerAuthentication, AuthorizationPolicy
│       ├── networkpolicy.yaml    CNI-level egress/ingress restrictions
│       ├── migration-job.yaml    alternative Helm-hook migration strategy
│       └── tests/test-api.yaml   `helm test` smoke test
│
├── .github/workflows/
│   ├── docker-build-push.yml     build + push to Docker Hub (commit-hash tag)
│   └── ci-security.yml           tests, npm audit, gitleaks, hadolint,
│                                 Trivy image + manifest scans, kubeconform
│
├── docker-compose.yml            local stack
├── Makefile / scripts/task.ps1   task runners
└── docs/                         the documentation table above
```

---

## What is deployed

| Object | Purpose |
|---|---|
| `Namespace` | Isolation, `istio-injection=enabled`, PodSecurity `restricted` |
| `Deployment` | 2 API replicas, migration initContainer, anti-affinity |
| `StatefulSet` | PostgreSQL 16 with an 8 Gi PVC (dev only — use a managed DB in prod) |
| `Service` x3 | API (`http-api`, `http-metrics`), Postgres, Postgres headless |
| `ConfigMap` | Non-secret configuration |
| `Secret` | Database credentials |
| `Gateway` + `VirtualService` | Istio ingress, retries, timeouts |
| `DestinationRule` | mTLS, connection pooling, outlier ejection |
| `PeerAuthentication` | mTLS **STRICT** — plaintext is refused |
| `AuthorizationPolicy` x4 | Default-deny, then allow gateway / metrics / probes |
| `NetworkPolicy` x2 | API egress limited to DNS + Postgres; DB ingress to API only |
| `PodDisruptionBudget` | Keeps a replica serving during node drains |
| `HorizontalPodAutoscaler` | Enabled in the prod overlay |
| `ServiceMonitor` | Prometheus scraping (prod overlay) |

---

## Verified

Everything below was executed against real infrastructure, not just written:

- **35 tests pass** — 22 unit, 13 integration against a live PostgreSQL,
  including proof that the database `CHECK` constraints reject bad data even
  when the API layer is bypassed.
- **Image builds and runs** — multi-stage, 0 HIGH/CRITICAL from the base, runs
  as uid 1000 with a read-only root filesystem and all capabilities dropped
  (confirmed inside the running container).
- **Full CRUD exercised** over HTTP against real Postgres; dates round-trip as
  calendar dates with no timezone drift.
- **Migrations are idempotent** — a second run reports `applied: 0`.
- **Chart lints and renders** cleanly for all three value sets (22 / 17 / 19
  objects), and every rendered document is valid YAML with the expected
  `apiVersion`, `kind` and `metadata.name`.

Not yet verified: a live `helm install` against a running cluster, because no
cluster is currently reachable from this machine. See
[docs/DEPLOY.md](docs/DEPLOY.md#getting-a-cluster) for the three ways to get one.

---

## Requirements

| Tool | Version | Needed for |
|---|---|---|
| Docker | 24+ | Building and running locally |
| Node.js | 20+ | Running tests outside a container |
| kubectl | 1.28+ | Talking to the cluster |
| Helm | 3.12+ | Deploying |
| Istio | 1.20+ | Ingress and mesh policy |

---

## Licence

MIT.
