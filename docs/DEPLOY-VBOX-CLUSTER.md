# Deploying to the VirtualBox lab cluster — step by step

A runbook for the specific cluster on this workstation (`vbox-k8s`, 1 master +
3 workers on VirtualBox). [DEPLOY.md](DEPLOY.md) covers kind / minikube /
Docker Desktop, all of which ship a default StorageClass and a way to
side-load images. This bare-metal kubeadm cluster ships neither, so there are
extra steps — and they must be done **in order**.

Verified against the live environment on 2026-09-14.

---

## 0. Why it does not deploy today

Seven things stand between the repo and a running release. The first is the
one actually blocking you; the rest are waiting behind it.

| # | Blocker | Evidence | Fixed in |
|---|---|---|---|
| 1 | **The cluster is gone.** `/etc/kubernetes` and `/var/lib/etcd` do not exist on any of the 4 nodes; kubelet is `inactive` everywhere; the VIP holds no address. Something ran a reset at **10:41 today**. | `ssh ubuntu@192.168.1.180 'ls /etc/kubernetes'` → No such file | [Phase 1](#phase-1--rebuild-the-cluster) |
| 2 | **`~/.kube/config` is stale.** It points at `https://192.168.1.179:8443`, a Keepalived VIP that no longer exists, and its client certs are from the destroyed CA. | `kubectl get nodes` → `dial tcp 192.168.1.179:8443: connectex` | [Phase 1](#phase-1--rebuild-the-cluster) |
| 3 | **`deploy.sh` will refuse to run.** `cluster.conf` sets `SSH_PASSWORD="ubuntu"`, and `sshpass` is not installed on this workstation. SSH key auth to all four nodes already works, so the password is not needed. | `deploy.sh:294` → `die "SSH_PASSWORD is set but 'sshpass' is not installed"` | [Phase 1](#phase-1--rebuild-the-cluster) |
| 4 | **No default StorageClass.** `deploy.sh` installs no storage provisioner. PostgreSQL's `volumeClaimTemplate` asks for 2 Gi and will sit `Pending` forever, so the API pods never get past their migration initContainer. | `grep -i provisioner deploy.sh` → nothing | [Phase 2](#phase-2--install-a-storageclass) |
| 5 | **Neither image is reachable from the cluster.** `employee-api` and `employee-frontend` exist only in Docker Desktop's image store; the nodes run containerd and cannot see them. And both `image.repository` values are still literal placeholders — the chart renders `docker.io/YOUR_DOCKERHUB_USERNAME/employee-api:1.0.0`. | `helm template` output | [Phase 3](#phase-3--get-both-images-onto-the-nodes) |
| 6 | **Istio is not installed.** The chart's preflight fails hard without the CRDs. | `kubectl get crd \| grep istio` → nothing | [Phase 5](#phase-5--add-the-mesh) |
| 7 | **`restricted` Pod Security rejects the Istio sidecar.** The namespace is labelled `pod-security.kubernetes.io/enforce: restricted`; the `istio-init` container runs as root with `NET_ADMIN`/`NET_RAW`, which that profile forbids. The `istio-cni` node agent removes that init container entirely. | `templates/namespace.yaml` + Istio CNI docs | [Phase 5](#phase-5--add-the-mesh) |

Run everything below from **Git Bash**, not PowerShell — `deploy.sh` and
`install-istio.sh` are bash.

---

## The environment

| | |
|---|---|
| Control plane | `master-1` — 192.168.1.180 (4 vCPU, 11 Gi) |
| Workers | `worker-1` .183, `worker-2` .184, `worker-3` .185 |
| API endpoint | `192.168.1.179:8443` — Keepalived VIP + HAProxy on master-1 |
| Kubernetes | v1.33.13, Calico v3.28.2, containerd |
| SSH | `ubuntu@<ip>`, key auth, passwordless sudo |
| Cluster tooling | `D:\Oracle\k8s-cluster` (`deploy.sh` + `cluster.conf`) |
| App repo | `D:\k8sscratch` |

The VM pool in `cluster.conf` lists 3 masters, but only `master-1` is
running — hence `-m 1 -w 3` on every `deploy.sh` call. The VIP stays
configured on purpose even with one master: `kubeadm` bakes
`controlPlaneEndpoint` in at init time, so a cluster initialised straight
against `192.168.1.180:6443` could never gain a second master without a full
re-init.

---

## Phase 1 — rebuild the cluster

**Gate: `kubectl get nodes` shows 4 nodes `Ready`.**

### 1.1 Let deploy.sh use your SSH key

`sshpass` is not installed and key auth already works, so clear the password:

```bash
cd /d/Oracle/k8s-cluster
sed -i 's|^SSH_PASSWORD=.*|SSH_PASSWORD=""|' cluster.conf
grep -n '^SSH_PASSWORD' cluster.conf
```

Leave `SUDO_PASSWORD` alone — it is harmless with passwordless sudo.

### 1.2 Clear the stale Calico state

The destroyed cluster left `tunl0` and blackhole routes behind on every node.
A reboot is the cheapest way to be sure they do not confuse the new install:

```bash
VB="/c/Program Files/Oracle/VirtualBox/VBoxManage.exe"
for vm in k8s-master-1 k8s-worker-1 k8s-worker-2 k8s-worker-3; do
  "$VB" controlvm "$vm" reset
done
sleep 60
```

### 1.3 Preflight, then deploy

```bash
./deploy.sh -m 1 -w 3 preflight     # must pass before you continue
./deploy.sh -m 1 -w 3 deploy        # ~10-15 minutes
```

This runs node prep on all four VMs in parallel, brings up HAProxy +
Keepalived so the VIP answers on `192.168.1.179:8443`, runs `kubeadm init`,
installs Calico, joins the workers, and writes `./kubeconfig`.

### 1.4 Point kubectl at the new cluster

The old certs are worthless — replace the config, do not merge it:

```bash
cp ~/.kube/config ~/.kube/config.broken-$(date +%Y%m%d)
cp ./kubeconfig ~/.kube/config
kubectl get nodes -o wide
```

Expect:

```
NAME       STATUS   ROLES           AGE   VERSION
master-1   Ready    control-plane   3m    v1.33.13
worker-1   Ready    <none>          2m    v1.33.13
worker-2   Ready    <none>          2m    v1.33.13
worker-3   Ready    <none>          2m    v1.33.13
```

---

## Phase 2 — install a StorageClass

**Gate: `kubectl get sc` shows one marked `(default)`.**

Nothing in the cluster can provision a PersistentVolume yet. Rancher's
local-path provisioner is the right weight for a lab — it carves volumes out
of each node's local disk.

```bash
kubectl apply -f https://raw.githubusercontent.com/rancher/local-path-provisioner/v0.0.37/deploy/local-path-storage.yaml
kubectl -n local-path-storage rollout status deploy/local-path-provisioner

kubectl patch storageclass local-path \
  -p '{"metadata":{"annotations":{"storageclass.kubernetes.io/is-default-class":"true"}}}'

kubectl get sc
```

```
NAME                   PROVISIONER             RECLAIMPOLICY   VOLUMEBINDINGMODE
local-path (default)   rancher.io/local-path   Delete          WaitForFirstConsumer
```

`WaitForFirstConsumer` means the PVC stays `Pending` until the Postgres pod is
scheduled — that is correct behaviour, not a fault.

> The volume is **node-local**. If `worker-2` dies, that PVC's data is not
> reachable from elsewhere. Fine for a lab; it is exactly why
> `values-prod.yaml` sets `postgresql.enabled: false`.

---

## Phase 3 — get both images onto the nodes

**Gate: `ctr -n k8s.io images ls` on each worker lists `employee-api:dev`
*and* `employee-frontend:dev`.**

There are **two** images: the Node API and the nginx frontend. Docker
Desktop's image store is invisible to the cluster's containerd, so pick one of
the options below for both.

### Option A — side-load (no registry, fastest to iterate)

```bash
cd /d/k8sscratch

# --provenance/--sbom off: buildx otherwise emits an image index with an
# "unknown/unknown" attestation entry that containerd can refuse to unpack.
docker build --provenance=false --sbom=false -t employee-api:dev      ./app
docker build --provenance=false --sbom=false -t employee-frontend:dev ./frontend

docker save employee-api:dev      -o /tmp/employee-api-dev.tar
docker save employee-frontend:dev -o /tmp/employee-frontend-dev.tar

for ip in 192.168.1.183 192.168.1.184 192.168.1.185; do
  echo "--- $ip"
  scp /tmp/employee-api-dev.tar /tmp/employee-frontend-dev.tar ubuntu@$ip:/tmp/
  ssh ubuntu@$ip 'sudo ctr -n k8s.io images import /tmp/employee-api-dev.tar                   && sudo ctr -n k8s.io images import /tmp/employee-frontend-dev.tar                   && rm -f /tmp/employee-api-dev.tar /tmp/employee-frontend-dev.tar'
done

# verify — expect two lines per worker
for ip in 192.168.1.183 192.168.1.184 192.168.1.185; do
  echo "--- $ip"
  ssh ubuntu@$ip 'sudo ctr -n k8s.io images ls -q | grep -E "employee-(api|frontend):dev" || echo MISSING'
done
```

Workers only — `master-1` carries the `control-plane:NoSchedule` taint, so no
app pod lands there. If you untaint it, load the images there too.

Deploy with an **empty registry** so the references stay `employee-api:dev`
and `employee-frontend:dev`, which containerd normalises to
`docker.io/library/...` and finds locally. These six flags appear in every
`helm upgrade` below:

```
--set image.registry=""          --set image.repository=employee-api      --set image.tag=dev
--set frontend.image.registry="" --set frontend.image.repository=employee-frontend --set frontend.image.tag=dev
```

**Re-import after every rebuild.** `imagePullPolicy: IfNotPresent` means a
node that already has `:dev` keeps running the old bits. Use a fresh tag
(`:dev2`, or the commit SHA) to avoid that trap entirely.

### Option B — push to Docker Hub (what CI does)

```bash
docker login
TAG=$(git rev-parse --short=7 HEAD)

docker build -t <you>/employee-api:$TAG      ./app
docker build -t <you>/employee-frontend:$TAG ./frontend
docker push  <you>/employee-api:$TAG
docker push  <you>/employee-frontend:$TAG
```

Then deploy with `--set image.repository=<you>/employee-api --set
image.tag=$TAG --set frontend.image.repository=<you>/employee-frontend --set
frontend.image.tag=$TAG`, leaving both registries at the `docker.io` default.

---

## Phase 4 — first deploy, without the mesh

**Gate: `curl /readyz` returns `{"status":"ready"}`.**

Deploy without Istio first. It removes four moving parts (CRDs, sidecar
injection, the gateway, mTLS) so that if something breaks here it is the
application, not the mesh.

### 4.0 Start from a clean database, or reuse the old password

`helm uninstall` **keeps** the namespace and the PersistentVolumeClaim on
purpose, so a teardown cannot take the database with it. That is the right
default — and a trap when you redeploy with a freshly generated password.

`POSTGRES_PASSWORD` is only read by `initdb`, which runs **only when the data
directory is empty**. A retained PVC already has one, so Postgres starts with
the *old* `employee_app` password while the API connects with the new one:

```
password authentication failed for user "employee_app"
```

and the migration initContainer sits in `Init:CrashLoopBackOff`.

Check whether a volume survived:

```bash
kubectl get pvc -n employee-dev
```

If it lists `data-employee-api-postgresql-0`, pick one:

```bash
# A. Clean slate — deletes the namespace, the PVC and all the data.
kubectl delete namespace employee-dev

# B. Keep the data — reuse the password the database was created with,
#    instead of generating a new one in 4.2.
kubectl get secret employee-api-secrets -n employee-dev \
  -o jsonpath='{.data.DB_PASSWORD}' | base64 -d
```

Option B only works while the old Secret still exists; `helm uninstall`
removes it, so in practice a torn-down release means option A.

---

### 4.1 Create the namespace — before Helm, not with it

Helm 3.19 writes its release Secret *into* the target namespace, so the
namespace has to exist first. But the chart also renders its own `Namespace`
object, because that is what applies the `istio-injection` and Pod Security
labels. So:

| What you do | What happens |
|---|---|
| Neither flag | `create: failed to create: namespaces "employee-dev" not found` |
| `--create-namespace` | `invalid ownership metadata ... cannot be imported into the current release` |
| **Pre-create with Helm's ownership metadata** | The chart adopts it and still applies its labels |

```bash
kubectl create namespace employee-dev

kubectl label namespace employee-dev app.kubernetes.io/managed-by=Helm --overwrite

kubectl annotate namespace employee-dev \
  meta.helm.sh/release-name=employee-api \
  meta.helm.sh/release-namespace=employee-dev --overwrite
```

Confirm afterwards that the chart's labels really did land:

```bash
kubectl get ns employee-dev -o jsonpath='{.metadata.labels}'
# expect istio-injection=enabled and pod-security.kubernetes.io/enforce=restricted
```

### 4.2 Install the release

```bash
cd /d/k8sscratch

# Hex, not base64: `openssl rand -base64` emits '=' and '/', which break
# Helm's --set parser.
export DB_PASSWORD="$(openssl rand -hex 16)"

helm upgrade --install employee-api ./charts/employee-api \
  --namespace employee-dev \
  -f charts/employee-api/values-dev.yaml \
  --set istio.enabled=false \
  --set image.registry="" \
  --set image.repository=employee-api \
  --set image.tag=dev \
  --set frontend.image.registry="" \
  --set frontend.image.repository=employee-frontend \
  --set frontend.image.tag=dev \
  --set secrets.dbPassword="$DB_PASSWORD" \
  --set secrets.postgresPassword="$DB_PASSWORD" \
  --wait --timeout 10m
```

Keep that `DB_PASSWORD` for Phase 5 — the same shell, or write it down. Every
upgrade passes it again, because this chart's `--reuse-values` is unsafe here
(see 5.4).

Watch it come up in another terminal:

```bash
kubectl get pods -n employee-dev -w
```

```
employee-api-postgresql-0        0/1  Pending           # PVC binding
employee-api-postgresql-0        1/1  Running
employee-api-5c9f...-4b2xk       0/1  Init:0/1          # migrations
employee-api-5c9f...-4b2xk       1/1  Running
employee-api-frontend-7c5...-xq  1/1  Running
```

Three workloads: the API, the frontend and PostgreSQL. `1/1`, not `2/2` —
there is no sidecar yet.

### Verify

Two things to check, because they are two separate Services.

**The UI.** nginx also proxies `/api` through to the API, so the whole
application works on this one port-forward:

```bash
kubectl port-forward -n employee-dev svc/employee-api-frontend 8080:80
```

```bash
curl -sS -o /dev/null -w "ui  %{http_code}\n" http://127.0.0.1:8080/
curl -sS -o /dev/null -w "api %{http_code}\n" http://127.0.0.1:8080/api/v1/employees
```

Then open <http://127.0.0.1:8080/> and add a record through the form.

**The API on its own:**

```bash
kubectl port-forward -n employee-dev svc/employee-api 8080:80
```

```bash
curl -s http://127.0.0.1:8080/readyz

curl -sX POST http://127.0.0.1:8080/api/v1/employees \
  -H 'Content-Type: application/json' \
  -d '{"name":"Ada Lovelace","dob":"1990-12-10","designation":"Principal Engineer","doj":"2015-06-01"}'

curl -s "http://127.0.0.1:8080/api/v1/employees?limit=10"

helm test employee-api -n employee-dev --logs
```

Port-forward works despite the NetworkPolicy: the policy has a deliberate
unrestricted rule on port 3000 so kubelet probes (which come from the node,
which has no namespace label) are not blocked.

**Stop here if you only need the app running.** Phase 5 is the mesh.

---

## Phase 5 — add the mesh

**Gate: app pods are `2/2` and the gateway answers on a NodePort.**

### 5.1 Install Istio

```bash
cd /d/k8sscratch
./scripts/install-istio.sh
```

Installs `istio-base`, `istiod` and `istio-ingressgateway` via Helm, in that
order.

> **Expect the last step to fail with `context deadline exceeded`.** The
> gateway chart creates a `Service` of type `LoadBalancer`, and Helm's `--wait`
> blocks until it gets an external IP — which bare metal never provides. The
> pods come up fine; only the release record is marked `failed`. Reconcile it
> by declaring the type it should have had:
>
> ```bash
> helm upgrade istio-ingressgateway istio/gateway -n istio-system \
>   --version 1.30.4 --set service.type=NodePort --wait --timeout 5m
> ```
>
> That both fixes the release and makes NodePort stick across future upgrades,
> so step 5.3 below is no longer needed as a separate patch.

### 5.2 Install the CNI node agent — required here

Without it, every injected pod is rejected: `istio-init` runs as root with
`NET_ADMIN` and `NET_RAW`, and this namespace enforces `restricted`. The node
agent does the same network setup from the node, so no init container is
injected at all.

```bash
helm upgrade --install istio-cni istio/cni -n istio-system --version 1.30.4 --wait

# NOT OPTIONAL: installing the chart does not tell istiod to stop injecting
# istio-init. Without this the PodSecurity rejection below continues.
helm upgrade istiod istio/istiod -n istio-system --version 1.30.4   --set cni.enabled=true --wait --timeout 5m

kubectl -n istio-system get pods
```

Confirm the injection changed shape — `istio-init` should be gone, replaced by
`istio-validation` plus an `istio-proxy` init container:

```bash
kubectl rollout restart deployment/employee-api -n employee-dev
kubectl get pod -n employee-dev -l app.kubernetes.io/component=api   -o jsonpath='{.items[0].spec.initContainers[*].name}'
# migrate istio-validation istio-proxy
```

Skipping the istiod flag produces:

```
Error creating: pods "employee-api-..." is forbidden: violates PodSecurity
"restricted:latest": non-default capabilities, runAsNonRoot != true
```

### 5.3 Expose the gateway as a NodePort

`istio-ingressgateway` defaults to `type: LoadBalancer`. Bare metal has no
load-balancer controller, so it would sit `<pending>` forever.

```bash
kubectl -n istio-system patch svc istio-ingressgateway \
  -p '{"spec":{"type":"NodePort"}}'

kubectl -n istio-system get svc istio-ingressgateway
```

Note the nodePort mapped to port 80 (something in the 30000-32767 range).

### 5.4 Redeploy with Istio on

```bash
helm upgrade --install employee-api ./charts/employee-api \
  --namespace employee-dev \
  -f charts/employee-api/values-dev.yaml \
  --set istio.enabled=true \
  --set image.registry="" \
  --set image.repository=employee-api \
  --set image.tag=dev \
  --set frontend.image.registry="" \
  --set frontend.image.repository=employee-frontend \
  --set frontend.image.tag=dev \
  --set secrets.dbPassword="$DB_PASSWORD" \
  --set secrets.postgresPassword="$DB_PASSWORD" \
  --wait --timeout 10m

kubectl delete pod -n employee-dev --all     # force re-injection
kubectl get pods -n employee-dev             # expect 2/2 for api AND frontend
```

> **Do not rely on `--reuse-values` here.** Combined with
> `-f values-dev.yaml`, that overlay's own `image.tag: ""` is re-applied on top
> of the `dev` tag you set at install time, silently reverting the image to
> `employee-api:1.0.0` and landing you in `ImagePullBackOff`. Pass the image
> and secret values explicitly on every upgrade instead:
>
> ```bash
>   --set image.registry="" --set image.repository=employee-api \
>   --set image.tag=dev \
>   --set frontend.image.registry="" \
>   --set frontend.image.repository=employee-frontend \
>   --set frontend.image.tag=dev \
>   --set secrets.dbPassword="$DB_PASSWORD" \
>   --set secrets.postgresPassword="$DB_PASSWORD"
> ```

The dev overlay leaves `istio.authorizationPolicy.enabled: false` on purpose —
the policy denies everything that is not the ingress gateway, which makes
`kubectl port-forward` straight to a pod fail and is the first thing anyone
tries when debugging.

### 5.5 Reach it through the gateway

```bash
NODEPORT=$(kubectl -n istio-system get svc istio-ingressgateway \
  -o jsonpath='{.spec.ports[?(@.port==80)].nodePort}')
BASE="http://192.168.1.183:$NODEPORT"

# the API
curl -s $BASE/readyz
curl -s "$BASE/api/v1/employees?limit=10"

# the UI — served by the frontend Deployment, not the API
curl -sS -o /dev/null -w "ui      %{http_code}\n" "$BASE/"
curl -sS -o /dev/null -w "ui css  %{http_code}\n" "$BASE/app.css"
```

Then open **`http://192.168.1.183:$NODEPORT/`** in a browser. Any node IP
works — kube-proxy forwards the NodePort from all of them.

The gateway splits by path: `/api`, `/healthz` and `/readyz` reach the API
directly; everything else goes to the frontend.

---

## The browser UI

The Employee Directory is its **own Deployment and Service**, not part of the
API container. nginx serves the static files; the API stays a pure JSON
service with a `default-src 'none'` CSP.

Why separate: the two scale independently, a UI rollout cannot restart the API
(or vice versa), and nginx serves static bytes better than Express does.

| Piece | Where |
|---|---|
| Markup, styles, script | `frontend/public/` |
| Image (nginx-unprivileged) | `frontend/Dockerfile` |
| nginx config | rendered by the chart into a ConfigMap |
| Deployment / Service / SA | `charts/employee-api/templates/frontend-*.yaml` |
| On/off switch | `frontend.enabled` |

```
                  ┌──────────────────────────┐
  client ────────▶│  Istio ingress gateway   │
                  └─────┬──────────────┬─────┘
                        │ /            │ /api, /healthz, /readyz
                        ▼              ▼
              ┌──────────────┐   ┌──────────────┐
              │ frontend     │   │ employee-api │──▶ postgresql
              │ nginx :8080  │   │ node :3000   │
              └──────┬───────┘   └──────▲───────┘
                     └──── /api ────────┘
                        (fallback only)
```

The gateway splits the traffic: `/api`, `/healthz` and `/readyz` go straight to
the API, everything else to the frontend. Same origin either way, so the
browser never needs CORS.

### Running it standalone

nginx also proxies `/api`, `/healthz` and `/readyz` to the API Service, so the
UI works when reached directly rather than through the gateway:

```bash
kubectl port-forward -n employee-dev svc/employee-api-frontend 8080:80
```

Set `frontend.proxyApi: false` to drop that and rely on the gateway alone. It
also removes the frontend's NetworkPolicy egress to the API and its principal
from the API's AuthorizationPolicy.

### Three nginx traps this config already avoids

> **`add_header` does not merge.** A single `add_header` inside a `location`
> block silently discards *every* `add_header` inherited from the `server`
> block. An earlier version set `Cache-Control` per-location and lost the CSP,
> `X-Frame-Options` and `Referrer-Policy` headers with it. Cache-Control is now
> chosen by a `map`, so all the headers are declared exactly once at server
> level.

> **Do not pass `Host $host` through `proxy_pass`.** Istio's sidecar routes
> outbound HTTP by Host header, not destination IP. Forwarding the original
> `employee-api-frontend` host makes Envoy route the request back to the
> frontend — an infinite loop that grows `X-Forwarded-For` until the headers
> exceed nginx's proxy buffer and it returns `502 upstream sent too big
> header`. The config sets the API's own service name as the Host.

> **No `upgrade-insecure-requests`, no HSTS by default.** On a plain-http
> endpoint that directive rewrites the page's own `/app.css` and `/app.js` to
> `https://`; they fail with `ERR_SSL_PROTOCOL_ERROR` and the UI loads unstyled
> and inert. Turn `frontend.publicTls: true` on only once TLS terminates in
> front, as `values-prod.yaml` does.

---

## Phase 6 — optional extras

| Want | Do |
|---|---|
| HPA to actually scale | `kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml`, then patch in `--kubelet-insecure-tls` (the kubelet serving certs here are self-signed), then `--set autoscaling.enabled=true` |
| `ServiceMonitor` | Install kube-prometheus-stack, then `--set metrics.serviceMonitor.enabled=true`. Without the CRDs the chart preflight fails on purpose. |
| A second master | `./deploy.sh add master-2 192.168.1.181`. Set **Promiscuous Mode = Allow All** on the masters' bridged adapters first, or VirtualBox drops the VRRP traffic and the VIP cannot float. Currently unset on all four VMs — harmless with one master, fatal with two. |

---

## Values you must change

Everything else in `values.yaml` works as shipped.

| Key | Shipped | Set to | Why |
|---|---|---|---|
| `image.repository` | `YOUR_DOCKERHUB_USERNAME/employee-api` | `employee-api` (side-load) or `<you>/employee-api` | Literal placeholder → `ImagePullBackOff` |
| `image.registry` | `docker.io` | `""` when side-loading | Keeps the ref local so containerd does not try to pull |
| `image.tag` | `""` → falls back to `1.0.0` | `dev`, or the commit SHA | `1.0.0` was never built or pushed |
| `secrets.dbPassword` | `ChangeMe-Dev-Only-8chars` | generated | Committed default |
| `secrets.postgresPassword` | `ChangeMe-Dev-Only-8chars` | generated, same value | Must match `dbPassword` — the bundled Postgres creates the app user from it |
| `istio.enabled` | `true` | `false` for Phase 4, `true` after Phase 5 | Preflight fails without the CRDs |
| `frontend.image.repository` | `YOUR_DOCKERHUB_USERNAME/employee-frontend` | `employee-frontend`, or `<you>/employee-frontend` | Literal placeholder → `ImagePullBackOff` |
| `frontend.image.registry` | `docker.io` | `""` when side-loading | Keeps the ref local |
| `frontend.image.tag` | `""` → `1.0.0` | `dev`, or the commit SHA | `1.0.0` was never built |
| `frontend.publicTls` | `false` | `true` only when TLS terminates in front | `true` over plain http breaks the UI's own assets |

Left alone deliberately:

| Key | Value | Why |
|---|---|---|
| `postgresql.persistence.storageClass` | `""` | Empty means "cluster default", which Phase 2 provides |
| `namespace.create` | `true` | The chart must own the namespace to set its labels |
| `networkPolicy.enabled` | `true` | Calico enforces these, so they are real here — unlike on kind |
| `metrics.serviceMonitor.enabled` | `false` | No Prometheus Operator |
| `autoscaling.enabled` | `false` (dev) | No metrics-server |
| `frontend.enabled` | `true` | Deploys the UI as its own workload |
| `frontend.proxyApi` | `true` | Lets the UI work via port-forward, not just the gateway |

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `dial tcp 192.168.1.179:8443` | Cluster down, or VIP not held | Phase 1. Check `systemctl is-active keepalived haproxy` on master-1 |
| `SSH_PASSWORD is set but 'sshpass' is not installed` | `cluster.conf` | Step 1.1 |
| `Istio is not installed in this cluster` | Chart preflight | Phase 5, or `--set istio.enabled=false` |
| Postgres pod `Pending`, PVC `Pending` | No default StorageClass | Phase 2 |
| `ImagePullBackOff` on `YOUR_DOCKERHUB_USERNAME/...` | `image.repository` not overridden | Phase 3 |
| `ErrImageNeverPull` / `not found` with a local tag | Image not imported on the node the pod landed on | Re-run the Phase 3 loop on **all** workers |
| `violates PodSecurity "restricted:latest"` | `istio-init` needs root + `NET_ADMIN` | Install `istio-cni` (5.2) |
| `istio-ingressgateway` EXTERNAL-IP `<pending>` | No load-balancer on bare metal | Patch to NodePort (5.3) |
| Pods `1/1` after enabling Istio | Sidecar not injected into already-running pods | `kubectl delete pod -n employee-dev --all` |
| `invalid ownership metadata` | `--create-namespace` was passed | `kubectl delete ns employee-dev` and reinstall without it |
| App code changes not showing | `IfNotPresent` + reused tag | New tag, re-import, `--set image.tag=<new>` |
| `namespaces "employee-dev" not found` on install | Helm writes its release Secret into the namespace | Pre-create it with Helm ownership metadata (Phase 4) |
| Gateway install ends `context deadline exceeded` | `--wait` waiting on a LoadBalancer IP | Reconcile with `--set service.type=NodePort` (5.1) |
| Still `violates PodSecurity` after installing istio-cni | istiod was never told to use it | `helm upgrade istiod ... --set cni.enabled=true` (5.2) |
| UI loads unstyled, `ERR_SSL_PROTOCOL_ERROR` on `/app.css` | `upgrade-insecure-requests` over plain http | `frontend.publicTls: false` |
| UI missing CSP / `X-Frame-Options` | an `add_header` in a `location` discarded the server-level ones | Declare all `add_header` once at server level |
| `502 upstream sent too big header` from nginx | `Host $host` made Istio loop the request back | Set Host to the API's service name |
| Image reverts to `:1.0.0` after an upgrade | `--reuse-values` re-applied the overlay's `image.tag: ""` | Pass `--set image.tag=` explicitly every time |
| `password authentication failed for user "employee_app"` after a redeploy | A retained PVC kept the old password; `initdb` only runs on an empty data dir | Delete the namespace, or reuse the old password (4.0) |

Useful:

```bash
kubectl describe pod -n employee-dev -l app.kubernetes.io/component=api
kubectl logs -n employee-dev -l app.kubernetes.io/component=api -c migrate    # migrations
kubectl logs -n employee-dev -l app.kubernetes.io/component=api -c api -f
kubectl logs -n employee-dev -l app.kubernetes.io/component=api -c istio-proxy --tail=50
kubectl get events -n employee-dev --sort-by=.lastTimestamp | tail -20
```

---

## Teardown

```bash
helm uninstall employee-api -n employee-dev
kubectl delete namespace employee-dev          # also deletes the PVC and its data
```

The namespace carries `helm.sh/resource-policy: keep`, so `helm uninstall`
alone leaves it — and the database — in place.

> **Before redeploying after an uninstall**, remember that the retained volume
> still holds the *old* database password. `POSTGRES_PASSWORD` is only applied
> by `initdb` on an empty data directory, so a new password will not take and
> the API fails with `password authentication failed for user "employee_app"`.
> See [4.0](#40-start-from-a-clean-database-or-reuse-the-old-password).
