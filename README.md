# Employee API — DevOps / DevSecOps Reference Project

A Node.js REST API storing employee records in PostgreSQL, with a browser UI
in front of it, deployed to Kubernetes with Helm, exposed through an Istio
ingress gateway, and built by GitHub Actions into Docker Hub images tagged
with the commit hash.

**Two workloads, two images.** The API is a pure JSON service; the Employee
Directory UI is a separate Deployment serving static files from nginx. They
scale independently and a UI rollout cannot restart the API.

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
                    ║    "/"  │              │ /api /healthz   ║
                    ║         ▼              ▼ /readyz         ║
                    ║   ┌──────────────┐  ┌────────────────┐   ║
                    ║   │ frontend     │  │ employee-api   │   ║
                    ║   │ Deployment   │  │ Deployment x2  │   ║
                    ║   │  ├ nginx:8080│  │  ├ initC:      │   ║
                    ║   │  └ envoy     │  │  │  migrate    │   ║
                    ║   └──────┬───────┘  │  ├ api :3000   │   ║
                    ║          │          │  └ envoy       │   ║
                    ║          └─ /api ──▶└───────┬────────┘   ║
                    ║             (fallback)      │            ║
                    ║              mTLS STRICT    │            ║
                    ║   ┌────────────────┐        │            ║
                    ║   │ postgresql     │◀───────┘            ║
                    ║   │ StatefulSet    │  only API pods,     ║
                    ║   │  + PVC 8Gi     │  by NetworkPolicy   ║
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

These steps are **ordered** — each one depends on the last.

```bash
# 1. A default StorageClass, or the PostgreSQL PVC never binds.
#    Skip only if `kubectl get sc` already shows one marked (default).
kubectl apply -f https://raw.githubusercontent.com/rancher/local-path-provisioner/v0.0.37/deploy/local-path-storage.yaml
kubectl patch storageclass local-path \
  -p '{"metadata":{"annotations":{"storageclass.kubernetes.io/is-default-class":"true"}}}'

# 2. Istio — the chart needs its CRDs.
./scripts/install-istio.sh

# 3. The CNI node agent. Without it istiod injects an `istio-init` container
#    that runs as root with NET_ADMIN, which this namespace's `restricted`
#    Pod Security profile rejects. Installing the chart is not enough: istiod
#    has to be told to use it.
helm upgrade --install istio-cni istio/cni -n istio-system --wait
helm upgrade istiod istio/istiod -n istio-system --set cni.enabled=true --wait

# 4. The namespace. Helm writes its release Secret into the namespace, so it
#    must exist first — but the chart also renders its own Namespace for the
#    istio-injection and PodSecurity labels. Create it carrying Helm's
#    ownership metadata so the chart adopts it and still applies those labels.
#    (Do NOT use --create-namespace: that fails with `invalid ownership
#    metadata`.)
kubectl create namespace employee-app
kubectl label namespace employee-app app.kubernetes.io/managed-by=Helm --overwrite
kubectl annotate namespace employee-app \
  meta.helm.sh/release-name=employee-api \
  meta.helm.sh/release-namespace=employee-app --overwrite

# 5. The release. Hex, not base64: `openssl rand -base64` emits '=' and '/',
#    which break Helm's --set parser.
export DB_PASSWORD="$(openssl rand -hex 16)"
export TAG=$(git rev-parse --short=7 HEAD)

helm upgrade --install employee-api ./charts/employee-api \
  --namespace employee-app \
  --set image.repository=amritmatti/employee-api \
  --set image.tag=$TAG \
  --set frontend.image.repository=amritmatti/employee-frontend \
  --set frontend.image.tag=$TAG \
  --set secrets.dbPassword="$DB_PASSWORD" \
  --set secrets.postgresPassword="$DB_PASSWORD" \
  --wait --timeout 10m

helm test employee-api -n employee-app
```

Both images must already be pushed, or side-loaded onto the nodes — see
[docs/BUILD.md](docs/BUILD.md).

Reaching it: on bare metal the ingress gateway has no LoadBalancer address, so
patch it to a NodePort and open `http://<node-ip>:<nodePort>/`.

```bash
kubectl -n istio-system patch svc istio-ingressgateway -p '{"spec":{"type":"NodePort"}}'
kubectl -n istio-system get svc istio-ingressgateway
```

Don't want the mesh? `--set istio.enabled=false`, then
`kubectl port-forward svc/employee-api-frontend 8080:80` — nginx proxies
`/api` through to the API, so the whole application works on that one port.

Full walkthrough: **[docs/DEPLOY.md](docs/DEPLOY.md)** for a generic cluster,
or **[docs/DEPLOY-VBOX-CLUSTER.md](docs/DEPLOY-VBOX-CLUSTER.md)** for the
step-by-step that was actually executed against a bare-metal kubeadm cluster,
with every trap it hit.

---

## Documentation

| Document | What it covers |
|---|---|
| **[docs/BUILD.md](docs/BUILD.md)** | Building the image, the CI pipeline, Docker Hub setup |
| **[docs/RUN.md](docs/RUN.md)** | Running locally with Compose or bare Node, running tests |
| **[docs/DEPLOY.md](docs/DEPLOY.md)** | Getting a cluster, installing Istio, Helm deploy, upgrade, rollback |
| **[docs/DEPLOY-VBOX-CLUSTER.md](docs/DEPLOY-VBOX-CLUSTER.md)** | Ordered, gated walkthrough on a bare-metal kubeadm cluster — storage, side-loading images, istio-cni, and the traps |
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
├── frontend/                     Employee Directory UI (separate image)
│   ├── public/                   index.html, app.css, app.js — no build step
│   └── Dockerfile                nginx-unprivileged, uid 101, listens on 8080
│
├── charts/employee-api/          Helm chart
│   ├── values.yaml               ALL config and secrets
│   ├── values-dev.yaml           dev overlay
│   ├── values-prod.yaml          prod overlay (external DB, HPA, TLS)
│   └── templates/
│       ├── namespace.yaml        istio-injection + PodSecurity restricted
│       ├── deployment.yaml       API + migration initContainer
│       ├── frontend-*.yaml       UI Deployment, Service, SA, nginx ConfigMap
│       ├── postgresql.yaml       StatefulSet + PVC + Services
│       ├── istio-*.yaml          Gateway, VirtualService, DestinationRule,
│       │                         PeerAuthentication, AuthorizationPolicy
│       ├── networkpolicy.yaml    CNI-level egress/ingress restrictions
│       ├── migration-job.yaml    alternative Helm-hook migration strategy
│       └── tests/test-api.yaml   `helm test` smoke test
│
├── .github/workflows/
│   ├── docker-build-push.yml     build + push BOTH images to Docker Hub,
│   │                             matrix over app/ and frontend/, one commit tag
│   └── ci-security.yml           tests, npm audit, gitleaks, hadolint and
│                                 Trivy image scans for both images,
│                                 manifest scan, kubeconform
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
| `Deployment` x2 | API (migration initContainer, anti-affinity) and the frontend (nginx, uid 101, read-only rootfs) |
| `StatefulSet` | PostgreSQL 16 with an 8 Gi PVC (dev only — use a managed DB in prod) |
| `Service` x4 | API (`http-api`, `http-metrics`), frontend (`http-ui`), Postgres, Postgres headless |
| `ServiceAccount` x2 | Separate identities, so the API's AuthorizationPolicy can name the frontend specifically |
| `ConfigMap` x2 | Non-secret configuration, and the rendered nginx config |
| `Secret` | Database credentials |
| `Gateway` + `VirtualService` | Istio ingress, retries, timeouts. Splits by path: `/api`, `/healthz`, `/readyz` to the API, everything else to the frontend |
| `DestinationRule` | mTLS, connection pooling, outlier ejection |
| `PeerAuthentication` | mTLS **STRICT** — plaintext is refused |
| `AuthorizationPolicy` x5 | Default-deny, then allow gateway / metrics / probes / frontend |
| `NetworkPolicy` x3 | API egress limited to DNS + Postgres; DB ingress to API only; frontend egress to DNS + API only |
| `PodDisruptionBudget` x2 | Keeps a replica of the API *and* of the frontend serving during node drains. Only rendered when that workload has more than one replica — a budget over a single replica makes its pod unevictable and blocks the drain outright |
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
- **Chart lints and renders** cleanly for all three value sets, and every
  rendered document is valid YAML with the expected `apiVersion`, `kind` and
  `metadata.name`.
- **Deployed to a real cluster** — a 4-node bare-metal kubeadm cluster
  (Kubernetes 1.33, Calico, containerd) with Istio 1.30 and the sidecar
  injected: API and frontend both `2/2 Running`, `helm test` green, and full
  CRUD driven through the ingress gateway *and* through the UI in a real
  browser. The ordered walkthrough, including every trap it hit, is in
  [docs/DEPLOY-VBOX-CLUSTER.md](docs/DEPLOY-VBOX-CLUSTER.md).

Not verified: the production overlay's TLS path — `frontend.publicTls: true`
and the gateway's `credentialName` render correctly but have never run against
a real TLS endpoint.

---

## Requirements

| Tool | Version | Needed for |
|---|---|---|
| Docker | 24+ | Building and running locally |
| Node.js | 20+ | Running tests outside a container |
| kubectl | 1.28+ | Talking to the cluster |
| Helm | 3.12+ | Deploying |
| Istio | 1.20+ | Ingress and mesh policy (plus the `cni` chart, for `restricted` Pod Security) |
| A default StorageClass | — | The PostgreSQL PVC; `local-path` is fine for a lab |

---

## Licence

MIT.
