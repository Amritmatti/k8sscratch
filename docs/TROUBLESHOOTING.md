# Troubleshooting

Symptom first, then cause, then fix.

---

## First moves

```bash
NS=employee-app

kubectl get pods -n $NS -o wide
kubectl get events -n $NS --sort-by=.lastTimestamp | tail -30
kubectl describe pod -n $NS <pod>
kubectl logs -n $NS <pod> -c api --tail=100
kubectl logs -n $NS <pod> -c migrate        # the migration initContainer
kubectl logs -n $NS <pod> -c istio-proxy    # when routing is the suspect
helm status employee-api -n $NS
```

`kubectl describe` is usually more informative than logs for a pod that never
started — the reason lives in the events at the bottom.

---

## Install and upgrade

### `no matches for kind "Gateway" in version "networking.istio.io/v1"`

Istio is not installed, so its CRDs do not exist.

```bash
istioctl install --set profile=demo -y
```

Or deploy without the mesh: `--set istio.enabled=false`.

### `namespaces "employee-app" already exists`

The chart creates the namespace so it can apply the injection and PodSecurity
labels, and Helm will not adopt one it did not create.

```bash
# Either let the chart own it
kubectl delete namespace employee-app

# Or keep yours and label it manually
helm upgrade --install employee-api ./charts/employee-api \
  -n employee-app --set namespace.create=false
kubectl label namespace employee-app istio-injection=enabled
```

### `UPGRADE FAILED: another operation is in progress`

A previous release is stuck.

```bash
helm history employee-api -n employee-app
helm rollback employee-api -n employee-app     # back to the last good revision
```

If it is wedged in `pending-install` and there is nothing to roll back to:

```bash
helm uninstall employee-api -n employee-app
```

### `Error: execution error at (employee-api/templates/...): secrets.dbPassword is required`

The chart refuses to render without a database password. Pass one:

```bash
--set secrets.dbPassword="$(openssl rand -base64 24)"
```

### Release times out with `--wait`

`--wait` blocks until pods are Ready, so this means they never became Ready.
Diagnose with the sections below — the release did not fail, the pods did.

---

## Pods

### `Init:0/1` for a long time, or `Init:Error`

The migration initContainer. Read its log:

```bash
kubectl logs -n $NS <pod> -c migrate
```

| In the log | Cause | Fix |
|---|---|---|
| `Database not ready yet, retrying` | Postgres still starting | Wait; it retries for `migrations.waitForDatabaseSeconds` (120s) |
| `password authentication failed` | Secret does not match what Postgres was initialised with | See "password authentication failed" below |
| `Migration ... has changed since it was applied` | An applied migration file was edited | Add a new migration; do not edit applied ones |
| `getaddrinfo ENOTFOUND` | DNS, or the wrong `DB_HOST` | Check the NetworkPolicy allows DNS |

### `CrashLoopBackOff`

```bash
kubectl logs -n $NS <pod> -c api --previous
```

| In the log | Cause |
|---|---|
| `Refusing to start with an invalid configuration` | A required variable is missing — the next lines name it |
| `EADDRINUSE` | `PORT` and `METRICS_PORT` are the same |
| OOMKilled (check `describe`) | Raise `resources.limits.memory`, and `NODE_OPTIONS=--max-old-space-size` with it |

### `Pending`

```bash
kubectl describe pod -n $NS <pod> | tail -20
```

| Message | Cause | Fix |
|---|---|---|
| `didn't match pod anti-affinity rules` | Fewer nodes than replicas with `type: hard` | `--set podAntiAffinity.type=soft`, or use `values-dev.yaml` |
| `Insufficient cpu/memory` | Cluster too small | Lower requests or add nodes |
| `pod has unbound immediate PersistentVolumeClaims` | No default StorageClass | `kubectl get storageclass`; set `postgresql.persistence.storageClass` |

### `ImagePullBackOff`

```bash
kubectl describe pod -n $NS <pod> | grep -A5 Events
```

- Wrong repository or tag — check `image.repository` and `image.tag`.
- Private repository — set `image.pullSecretName`.
- Using a locally built image on kind/minikube — it must be loaded into the
  cluster and `pullPolicy` set to `Never`:

```bash
kind load docker-image employee-api:dev --name employee
helm upgrade ... --set image.registry="" --set image.repository=employee-api \
  --set image.tag=dev --set image.pullPolicy=Never
```

### Pod is `1/2` — only one container ready

The sidecar is fine but the app is not Ready (or vice versa).

```bash
kubectl describe pod -n $NS <pod> | grep -A10 "Readiness"
kubectl exec -n $NS <pod> -c api -- \
  node -e "fetch('http://127.0.0.1:3000/readyz').then(r=>r.text()).then(console.log)"
```

If it reports `{"checks":{"database":"unreachable"}}`, go to the database
section.

### No sidecar at all — pod is `1/1`

Injection did not happen.

```bash
kubectl get namespace $NS --show-labels | grep istio-injection
kubectl get pods -n istio-system -l app=istiod
```

The label is applied when the namespace is created. Adding it later only affects
**new** pods:

```bash
kubectl label namespace $NS istio-injection=enabled --overwrite
kubectl rollout restart deployment/employee-api -n $NS
```

---

## Database

### `password authentication failed for user "employee_app"`

Almost always this: **PostgreSQL only reads `POSTGRES_PASSWORD` when it
initialises an empty data directory.** If the PVC already exists from an earlier
install, changing the password in `values.yaml` updates the Secret the app uses
but not the password stored in the database.

```bash
# Option A — set the password to match the new Secret
kubectl exec -it -n $NS employee-api-postgresql-0 -- \
  psql -U employee_app -d employees \
  -c "ALTER USER employee_app WITH PASSWORD 'the-new-password';"

# Option B — start over (DESTROYS THE DATA)
helm uninstall employee-api -n $NS
kubectl delete pvc -n $NS -l app.kubernetes.io/component=database
helm upgrade --install employee-api ./charts/employee-api -n $NS ...
```

### Readiness reports `database: unreachable`

```bash
# Is Postgres up?
kubectl get pods -n $NS -l app.kubernetes.io/component=database
kubectl logs -n $NS employee-api-postgresql-0 --tail=50

# Does DNS resolve from an API pod?
kubectl exec -n $NS <api-pod> -c api -- \
  node -e "require('dns').lookup('employee-api-postgresql',(e,a)=>console.log(e||a))"
```

If DNS fails, the NetworkPolicy is blocking it — confirm `networkPolicy.allowDNS`
is true and that `kube-system` carries the
`kubernetes.io/metadata.name` label your cluster version sets.

### `too many connections`

`DB_POOL_MAX` × replicas exceeds the server's `max_connections` (default 100).
At 12 replicas × 10 that is 120.

```bash
helm upgrade ... --reuse-values --set config.dbPoolMax=5
```

Or put PgBouncer in front.

---

## Istio and routing

### 404 from the gateway

```bash
# Is the route programmed?
istioctl proxy-config routes -n istio-system deploy/istio-ingressgateway | grep employee

# Does the Gateway selector match the ingress deployment's labels?
kubectl get gateway -n $NS employee-api -o yaml | grep -A3 selector
kubectl get pods -n istio-system -l istio=ingressgateway
```

Common causes:

- **Host mismatch.** `istio.gateway.hosts` is `employees.example.com` but you
  curled an IP. Send the header: `curl -H 'Host: employees.example.com' ...`
- **Selector mismatch.** The Gateway selects `istio: ingressgateway`; your
  install may label it differently.
- **TLS secret in the wrong namespace.** For HTTPS, `credentialName` must name a
  Secret in **istio-system**, not the app namespace. This is the single most
  common HTTPS 404.

### 503 `upstream connect error`

```bash
kubectl get endpoints -n $NS employee-api
```

Empty endpoints means no Ready pods — go back to the pod section.

If endpoints exist, check port naming: the Service ports must be named
`http-api` / `http-metrics`. An unnamed or wrongly-prefixed port makes Istio
treat the traffic as opaque TCP and the VirtualService rules will not apply.

### 403 `RBAC: access denied`

The AuthorizationPolicy is doing its job — the caller is not allowed.

```bash
kubectl get authorizationpolicy -n $NS
```

- Calling from outside the gateway (a direct `port-forward` to the pod) is
  denied by design. Disable it in dev: `--set istio.authorizationPolicy.enabled=false`
  (already off in `values-dev.yaml`).
- If the **gateway** gets 403, its service account principal does not match
  `istio.authorizationPolicy.ingressGatewayPrincipal`. Check the real one:

```bash
kubectl get pod -n istio-system -l istio=ingressgateway \
  -o jsonpath='{.items[0].spec.serviceAccountName}'
```

### Pods never Ready after enabling authorization policies

The kubelet's probes come from the node with no mesh identity. The
`allow-probes` policy exists for exactly this. If you replaced the policies, make
sure probe paths are still permitted.

---

## Local development

### `port is already allocated`

```bash
API_PORT=8000 METRICS_HOST_PORT=9100 POSTGRES_PORT=5555 docker compose up -d
```

Defaults are already 3080 / 9091 / 55432 to dodge the usual conflicts.

### `failed to connect to the docker API`

Docker Desktop is not running. Start it and wait for the whale icon to settle —
it can take a couple of minutes.

### Integration tests all skip

They skip when no database is reachable. Start one and pass the connection
details:

```bash
docker compose up -d postgres
cd app && DB_HOST=127.0.0.1 DB_PORT=55432 DB_NAME=employees \
  DB_USER=employee_app DB_PASSWORD=local-dev-password npm run test:integration
```

### `read-only file system` in the container

Intended — `readOnlyRootFilesystem: true`. Anything that needs to write needs an
explicit volume. `/tmp` is already mounted as an in-memory emptyDir.

---

## CI

### `npm ci` fails: lockfile out of sync

```bash
cd app && npm install && git add package-lock.json
```

### Trivy fails the build

```bash
trivy image --severity HIGH,CRITICAL --ignore-unfixed youruser/employee-api:tag
```

Usually a base image CVE — rebuild to pick up a newer `node:22-alpine`. If there
is genuinely no fix available, `--ignore-unfixed` already excludes it; if it is
fixed upstream, update the dependency.

### Gitleaks finds a secret

Rotate it first — it is in the git history and removing the file does not remove
it from history. Then purge with `git filter-repo` or BFG if the repository is
shared.

---

## Getting a clean slate

```bash
# Local
docker compose down -v

# Cluster — keeps the database
helm uninstall employee-api -n employee-app

# Cluster — removes everything including data
kubectl delete namespace employee-app
```
