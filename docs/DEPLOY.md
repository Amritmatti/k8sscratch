# Deploying to Kubernetes

From an empty machine to a running, verified release.

---

## Contents

1. [Prerequisites](#prerequisites)
2. [Getting a cluster](#getting-a-cluster)
3. [Installing Istio](#installing-istio)
4. [Deploying](#deploying)
5. [Reaching the API](#reaching-the-api)
6. [Verifying](#verifying)
7. [Upgrading and rolling back](#upgrading-and-rolling-back)
8. [Production](#production)
9. [Uninstalling](#uninstalling)

---

## Prerequisites

| Tool | Version | Check |
|---|---|---|
| kubectl | 1.28+ | `kubectl version --client` |
| Helm | 3.12+ | `helm version` |
| Istio | 1.20+ | `istioctl version` |
| A cluster | 1.28+ | `kubectl get nodes` |

Your image must already be pushed. See [BUILD.md](BUILD.md), or for a local
cluster load it directly (no registry needed) — covered below.

---

## Getting a cluster

Skip if `kubectl get nodes` already works.

### kind (fastest)

```bash
# Install (Linux/macOS)
go install sigs.k8s.io/kind@latest
# or: brew install kind
# Windows: winget install Kubernetes.kind

cat <<'EOF' | kind create cluster --name employee --config=-
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
  - role: control-plane
    kubeadmConfigPatches:
      - |
        kind: InitConfiguration
        nodeRegistration:
          kubeletExtraArgs:
            node-labels: "ingress-ready=true"
    extraPortMappings:
      # Publish the Istio gateway on the host so you can curl it directly.
      - containerPort: 30080
        hostPort: 8080
        protocol: TCP
  - role: worker
  - role: worker
EOF

kubectl cluster-info --context kind-employee
```

Two workers so pod anti-affinity has somewhere to spread to.

**Loading the image without a registry** — very useful while iterating:

```bash
docker build -t employee-api:dev ./app
kind load docker-image employee-api:dev --name employee

helm upgrade --install employee-api ./charts/employee-api \
  --namespace employee-app \
  --set image.registry="" \
  --set image.repository=employee-api \
  --set image.tag=dev \
  --set image.pullPolicy=Never          # never go looking for it remotely
```

### minikube

```bash
minikube start --nodes 2 --cpus 4 --memory 8192
minikube addons enable metrics-server   # needed for the HPA
eval $(minikube docker-env)             # build straight into the cluster
```

### Docker Desktop

**Settings → Kubernetes → Enable Kubernetes**. Single node, so use the dev
overlay (it disables anti-affinity and the PDB, both of which need more than
one node).

---

## Installing Istio

The chart creates `Gateway`, `VirtualService`, `DestinationRule`,
`PeerAuthentication` and `AuthorizationPolicy` objects. Without Istio those CRDs
do not exist, and the chart stops before Helm gets that far:

```
Istio is not installed in this cluster.
...
Pick one:
  1. Install Istio ...
  2. Deploy without the mesh ...
```

The preflight check exists so you get one actionable message instead of a
"resource mapping not found" line per object.

### Option A — the helper script (no extra tools)

```bash
./scripts/install-istio.sh
```

Installs `istio-base`, `istiod` and `istio-ingressgateway` with Helm, in that
order, then reports how to reach the gateway. Pin a version with
`ISTIO_VERSION=1.24.2 ./scripts/install-istio.sh`; remove it with
`./scripts/install-istio.sh --uninstall`.

### Option B — Helm by hand

```bash
helm repo add istio https://istio-release.storage.googleapis.com/charts
helm repo update

helm install istio-base istio/base -n istio-system --create-namespace --wait
helm install istiod istio/istiod -n istio-system --wait
helm install istio-ingressgateway istio/gateway -n istio-system --wait
```

### Option C — istioctl

```bash
curl -L https://istio.io/downloadIstio | sh -
cd istio-*/ && export PATH=$PWD/bin:$PATH

istioctl install --set profile=demo -y
```

Verify whichever you chose:

```bash
kubectl get pods -n istio-system
# istiod-...                 1/1 Running
# istio-ingressgateway-...   1/1 Running

kubectl get crd | grep -c istio.io      # expect 12+
```

The `demo` profile is fine for evaluation. Use `default` for production — it
omits the extra telemetry addons.

**On kind**, expose the gateway on the port you mapped:

```bash
kubectl patch svc istio-ingressgateway -n istio-system --type=json -p='[
  {"op":"replace","path":"/spec/type","value":"NodePort"},
  {"op":"replace","path":"/spec/ports/1/nodePort","value":30080}
]'
```

### Running without Istio

Everything works without the mesh — you lose ingress, mTLS and the
authorization policies, and reach the API by port-forward instead:

```bash
helm upgrade --install employee-api ./charts/employee-api \
  --namespace employee-app --set istio.enabled=false
```

---

## Deploying

### 1. Namespace

> **Do not pass `--create-namespace`.** The chart renders its own `Namespace`
> object so it can apply the `istio-injection=enabled` and PodSecurity labels.
> `--create-namespace` makes Helm create the namespace first, without those
> labels and without release ownership, and the install then fails with
> `invalid ownership metadata ... exists and cannot be imported into the
> current release`.
>
> Pass `--namespace` on its own. Helm creates and owns the namespace from the
> chart.

```bash
helm upgrade --install employee-api ./charts/employee-api \
  --namespace employee-app \
  ...
```

If the namespace already exists, Helm will refuse to adopt it. Either set
`--set namespace.create=false` and label it yourself:

```bash
kubectl label namespace employee-app istio-injection=enabled
```

or delete it and let the chart create it.

### 2. Generate credentials

Do not deploy the default passwords.

```bash
export DB_PASSWORD="$(openssl rand -base64 24)"
```
```powershell
$env:DB_PASSWORD = [Convert]::ToBase64String((1..24 | ForEach-Object { Get-Random -Max 256 }))
```

### 3. Install

```bash
helm upgrade --install employee-api ./charts/employee-api \
  --namespace employee-app \
  --set image.repository=YOUR_DOCKERHUB_USERNAME/employee-api \
  --set image.tag=$(git rev-parse --short=7 HEAD) \
  --set secrets.dbPassword="$DB_PASSWORD" \
  --set secrets.postgresPassword="$DB_PASSWORD" \
  --wait --timeout 10m
```

`--wait` blocks until every pod is Ready, so the command failing means the
deployment failed — no separate check needed.

Development overlay (single replica, small resources, relaxed limits):

```bash
helm upgrade --install employee-api ./charts/employee-api \
  --namespace employee-dev \
  -f charts/employee-api/values-dev.yaml \
  --set image.tag=$(git rev-parse --short=7 HEAD) \
  --wait
```

### 4. Watch it come up

```bash
kubectl get pods -n employee-app -w
```

Expect, in order:

```
employee-api-postgresql-0        0/1  ContainerCreating    # PVC binding
employee-api-postgresql-0        1/1  Running
employee-api-7d4f8b9c5-xk2p9     0/2  Init:0/1             # migrations
employee-api-7d4f8b9c5-xk2p9     0/2  PodInitializing
employee-api-7d4f8b9c5-xk2p9     2/2  Running              # app + envoy
```

`2/2` because the Istio sidecar is the second container.

### What happens during install

1. Namespace created and labelled for sidecar injection.
2. Secret and ConfigMap created.
3. PostgreSQL StatefulSet starts; its PVC is provisioned.
4. API pods start. Each runs the **migration initContainer** first, which waits
   for the database, takes a Postgres advisory lock and applies any pending
   migrations. With several replicas, one migrates and the rest see nothing to
   do. No pod can serve traffic against an un-migrated schema.
5. The app container starts, passes its startup probe, then readiness.
6. Istio objects are applied; the gateway begins routing.

### Migration strategies

`migrations.strategy` controls step 4:

| Value | Behaviour | Use when |
|---|---|---|
| `initContainer` *(default)* | Every pod migrates before starting | Almost always — correct in every ordering |
| `hook` | A Helm `post-install`/`pre-upgrade` Job | You want a bad migration to fail the release itself |
| `none` | You run them | Migrations are managed by another pipeline |

> The hook **cannot** be `pre-install`: Helm runs pre-install hooks before the
> PostgreSQL StatefulSet exists, so the Job would sit waiting for a database
> that has not been created yet and time out.

---

## Reaching the API

### With a LoadBalancer

```bash
export INGRESS_HOST=$(kubectl -n istio-system get svc istio-ingressgateway \
  -o jsonpath='{.status.loadBalancer.ingress[0].ip}')
export INGRESS_PORT=80
```

### On kind / minikube / bare metal

Port-forward the gateway:

```bash
kubectl -n istio-system port-forward svc/istio-ingressgateway 8080:80
export INGRESS_HOST=127.0.0.1 INGRESS_PORT=8080
```

### Without Istio

```bash
kubectl -n employee-app port-forward svc/employee-api 8080:80
export INGRESS_HOST=127.0.0.1 INGRESS_PORT=8080
```

### Then

```bash
BASE="http://$INGRESS_HOST:$INGRESS_PORT"

curl -s $BASE/readyz

curl -sX POST $BASE/api/v1/employees \
  -H 'Content-Type: application/json' \
  -d '{"name":"Ada Lovelace","dob":"1990-12-10","designation":"Principal Engineer","doj":"2015-06-01"}'

curl -s "$BASE/api/v1/employees?limit=10"
```

---

## Verifying

### Smoke test

```bash
helm test employee-api -n employee-app --logs
```

Runs a Pod in the cluster that checks liveness, checks readiness reports the
database is reachable, creates an employee, reads it back and deletes it.

### Check the mesh

```bash
POD=$(kubectl get pod -n employee-app -l app.kubernetes.io/component=api \
  -o jsonpath='{.items[0].metadata.name}')

# Sidecar injected? Expect 2 containers.
kubectl get pod $POD -n employee-app -o jsonpath='{.spec.containers[*].name}'

# mTLS and policy as configured?
istioctl x describe pod -n employee-app $POD

# Is the route programmed in the gateway?
istioctl proxy-config routes \
  -n istio-system deploy/istio-ingressgateway | grep employee
```

### Check the security posture

```bash
# Non-root, read-only root filesystem, no capabilities
kubectl get pod $POD -n employee-app \
  -o jsonpath='{.spec.containers[0].securityContext}' | jq

# The pod has no service account token to steal
kubectl exec -n employee-app $POD -c api -- \
  ls /var/run/secrets/kubernetes.io/serviceaccount 2>&1 || echo "no token — correct"

# Egress is restricted: this should fail
kubectl exec -n employee-app $POD -c api -- \
  node -e "fetch('https://example.com').then(()=>console.log('REACHED — policy not enforced')).catch(()=>console.log('blocked — correct'))"
```

> The last check only means something if your CNI enforces NetworkPolicy
> (Calico, Cilium, Antrea). kind's default CNI does **not** — the objects are
> accepted and silently ignored. Create the cluster with
> `--config` disabling the default CNI and install Calico to test them properly.

### Logs

```bash
kubectl logs -n employee-app -l app.kubernetes.io/component=api -c api -f --tail=100

# Migration output (initContainer)
kubectl logs -n employee-app $POD -c migrate

# The Envoy sidecar, when routing is the suspect
kubectl logs -n employee-app $POD -c istio-proxy --tail=50
```

---

## Upgrading and rolling back

### Deploy a new version

```bash
helm upgrade employee-api ./charts/employee-api \
  --namespace employee-app \
  --reuse-values \
  --set image.tag=$(git rev-parse --short=7 HEAD) \
  --wait --timeout 10m
```

`--reuse-values` keeps the secrets you passed at install time so you do not have
to supply them again.

The rollout is one pod at a time (`maxUnavailable: 0`, `maxSurge: 1`), so
capacity never dips. A new pod must pass its readiness probe before the next
old one is removed.

### Preview the change first

```bash
helm plugin install https://github.com/databus23/helm-diff
helm diff upgrade employee-api ./charts/employee-api \
  -n employee-app --reuse-values --set image.tag=abc1234
```

### Roll back

```bash
helm history employee-api -n employee-app
helm rollback employee-api -n employee-app          # previous revision
helm rollback employee-api 3 -n employee-app        # a specific one
```

> Rolling back the application does **not** roll back the database. A migration
> that dropped a column leaves the older image querying something that no longer
> exists. Write migrations so that the previous version still works against the
> new schema — add columns, do not rename them; remove only after the code that
> used them is gone.

### Scale

```bash
kubectl scale deployment/employee-api -n employee-app --replicas=5

# or turn on autoscaling (needs metrics-server)
helm upgrade employee-api ./charts/employee-api -n employee-app \
  --reuse-values --set autoscaling.enabled=true
```

---

## Production

Start from `values-prod.yaml`, which already sets:

- 3 replicas, HPA to 12, hard anti-affinity, PDB `minAvailable: 2`
- TLS at the gateway with an HTTPS redirect
- mTLS `STRICT`, authorization policies on
- `postgresql.enabled: false` — use a managed database
- `ServiceMonitor` for Prometheus

### Checklist

- [ ] **Pin the image to a commit SHA.** Never `latest`.
- [ ] **Secrets out of git.** Use `secrets.existingSecret` with External
      Secrets / Sealed Secrets / Vault, or pass `--set` from your CI's secret
      store. `values-prod.yaml` deliberately contains no passwords.
- [ ] **Managed database.** The bundled StatefulSet is one replica with no
      failover, no backups and no point-in-time recovery.
- [ ] **`DB_SSL=true`** for a managed database.
- [ ] **Real hostname** in `istio.gateway.hosts` — not `*`, so the
      VirtualService cannot be reached under another name.
- [ ] **TLS secret in `istio-system`**, not the app namespace. This is the most
      common cause of a Gateway 404 on HTTPS.
- [ ] **Confirm your CNI enforces NetworkPolicy.**
- [ ] **Resource requests sized from real load**, not guesses.
- [ ] **Backups tested by restoring one**, not just scheduled.

### With an external database

```bash
helm upgrade --install employee-api ./charts/employee-api \
  --namespace employee-prod \
  -f charts/employee-api/values-prod.yaml \
  --set image.tag=$GIT_SHA \
  --set externalDatabase.host=employee-db.abc123.eu-west-1.rds.amazonaws.com \
  --set secrets.existingSecret=employee-api-db-credentials \
  --wait
```

The referenced Secret must contain `DB_NAME`, `DB_USER` and `DB_PASSWORD`.

---

## Uninstalling

```bash
helm uninstall employee-api -n employee-app
```

The namespace and the PersistentVolumeClaim are **kept** on purpose — the
namespace carries `helm.sh/resource-policy: keep` so uninstalling cannot take
the database with it.

To remove everything including the data:

```bash
kubectl delete namespace employee-app     # deletes the PVC and its data
```
