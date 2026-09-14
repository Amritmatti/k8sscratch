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

### `Istio is not installed in this cluster`

The chart's preflight check. Install Istio:

```bash
./scripts/install-istio.sh
```

or deploy without the mesh — you lose ingress, mTLS and the authorization
policies, and reach the API by port-forward:

```bash
helm upgrade --install employee-api ./charts/employee-api   --namespace employee-app --set istio.enabled=false
```

### `no matches for kind "Gateway" in version "networking.istio.io/v1"`

The same problem, reported by Helm rather than the chart — you will see this if
`istio.requireCRDs=false` was set, which switches the preflight check off.

Turn the check back on (drop the flag) for a clearer message, then install
Istio. `requireCRDs=false` exists only for `helm template` and CI, which have
no cluster to query.

### `Namespace "employee-app" ... cannot be imported into the current release`

You passed `--create-namespace`. Do not: the chart renders its own `Namespace`
so it can apply the `istio-injection` and PodSecurity labels. Helm pre-creating
it produces an unowned namespace the release cannot adopt.

```bash
kubectl delete namespace employee-app     # if it is empty and yours
helm upgrade --install employee-api ./charts/employee-api --namespace employee-app
```

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

Reproduce exactly what CI gates on:

```bash
docker build -t employee-api:scan ./app
trivy image --scanners vuln --severity HIGH,CRITICAL --ignore-unfixed   --exit-code 1 employee-api:scan
```

Then find out *where* the finding lives, which decides the fix:

```bash
trivy image --scanners vuln --severity HIGH,CRITICAL --ignore-unfixed   --format json employee-api:scan   | jq -r '.Results[].Vulnerabilities[]? | "\(.PkgPath // "os") \(.PkgName) \(.VulnerabilityID)"'
```

| `PkgPath` | Meaning | Fix |
|---|---|---|
| `(os)` / empty | Alpine package | `apk upgrade` in the Dockerfile — already done |
| `usr/local/lib/node_modules/npm/...` | npm's own bundled deps | Not your code. npm is deleted from the runtime image — if these reappear, that step was removed |
| `app/node_modules/...` | **Your** dependency | Update it: `npm update <pkg>` or bump it in `package.json` |

### Trivy fails but the log shows no findings

The log ends with `Error: Process completed with exit code 1` after
`Building SARIF report with all severities`, and nothing about what was found.

This is a trivy-action behaviour, not a scan result: when `format: sarif` is
set, the action **drops** the `severity` and `ignore-unfixed` inputs and builds
the report at every severity. Pairing that with `exit-code: '1'` fails the job
on any LOW or MEDIUM finding, and because the report is written to a file
rather than stdout the log cannot tell you which.

The workflow therefore uses two steps: one produces the SARIF for the Security
tab with `exit-code: '0'`, the other gates with `format: table`,
`severity: HIGH,CRITICAL`, `ignore-unfixed: true` and `exit-code: '1'` so a
failure prints the offending packages. Do not merge them back into one step.

### Hadolint fails the build

```bash
docker run --rm -i hadolint/hadolint:latest-alpine   hadolint --failure-threshold warning - < app/Dockerfile
```

`info` findings do not fail; `warning` and above do. Two that were hit here:

- **DL3025** — `CMD`/`HEALTHCHECK` in shell form. Use JSON exec form.
- **DL3066** — non-numeric user id. `USER 1000:1000`, not `USER node`. This one
  matters beyond the linter: with `runAsNonRoot: true` the kubelet cannot verify
  a *named* user is non-root and refuses to start the container unless
  `runAsUser` is also set.

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
