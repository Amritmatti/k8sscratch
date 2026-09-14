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
| 5 | **The image is not reachable from the cluster.** `employee-api` exists only in Docker Desktop's image store; the nodes run containerd and cannot see it. And `image.repository` is still the literal placeholder — the chart renders `docker.io/YOUR_DOCKERHUB_USERNAME/employee-api:1.0.0`. | `helm template` output | [Phase 3](#phase-3--get-the-image-onto-the-nodes) |
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

## Phase 3 — get the image onto the nodes

**Gate: `ctr -n k8s.io images ls` on each worker lists `employee-api:dev`.**

Docker Desktop's image store is invisible to the cluster's containerd. Pick
one of these.

### Option A — side-load (no registry, fastest to iterate)

```bash
cd /d/k8sscratch
docker build -t employee-api:dev ./app
docker save employee-api:dev -o /tmp/employee-api-dev.tar

for ip in 192.168.1.183 192.168.1.184 192.168.1.185; do
  echo "--- $ip"
  scp /tmp/employee-api-dev.tar ubuntu@$ip:/tmp/
  ssh ubuntu@$ip 'sudo ctr -n k8s.io images import /tmp/employee-api-dev.tar && rm /tmp/employee-api-dev.tar'
done

# verify
for ip in 192.168.1.183 192.168.1.184 192.168.1.185; do
  ssh ubuntu@$ip 'sudo ctr -n k8s.io images ls -q | grep employee || echo MISSING'
done
```

Workers only — `master-1` carries the `control-plane:NoSchedule` taint, so no
app pod lands there. If you untaint it, load the image there too.

Then deploy with an **empty registry** so the reference stays
`employee-api:dev`, which containerd normalises to
`docker.io/library/employee-api:dev` and finds locally:

```
--set image.registry="" --set image.repository=employee-api --set image.tag=dev
```

**Re-import after every rebuild.** `imagePullPolicy: IfNotPresent` means a
node that already has `employee-api:dev` will keep running the old bits. Use a
fresh tag (`:dev2`, or the commit SHA) to avoid that trap entirely.

### Option B — push to Docker Hub (what CI does)

```bash
docker login
docker build -t <you>/employee-api:$(git rev-parse --short=7 HEAD) ./app
docker push <you>/employee-api:$(git rev-parse --short=7 HEAD)
```

Then deploy with `--set image.repository=<you>/employee-api --set
image.tag=$(git rev-parse --short=7 HEAD)` and leave `image.registry` at its
`docker.io` default.

---

## Phase 4 — first deploy, without the mesh

**Gate: `curl /readyz` returns `{"status":"ready"}`.**

Deploy without Istio first. It removes four moving parts (CRDs, sidecar
injection, the gateway, mTLS) so that if something breaks here it is the
application, not the mesh.

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
  --set secrets.dbPassword="$DB_PASSWORD" \
  --set secrets.postgresPassword="$DB_PASSWORD" \
  --wait --timeout 10m
```

> **Never pass `--create-namespace`.** The chart renders its own `Namespace` so
> it can apply the `istio-injection` and Pod Security labels. Helm creating it
> first strips those labels and the install fails with
> `invalid ownership metadata`.

Watch it come up in another terminal:

```bash
kubectl get pods -n employee-dev -w
```

```
employee-api-postgresql-0      0/1  Pending             # PVC binding
employee-api-postgresql-0      1/1  Running
employee-api-5c9f...-4b2xk     0/1  Init:0/1            # migrations
employee-api-5c9f...-4b2xk     1/1  Running
```

`1/1`, not `2/2` — there is no sidecar yet.

### Verify

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

### 5.2 Install the CNI node agent — required here

Without it, every injected pod is rejected: `istio-init` runs as root with
`NET_ADMIN` and `NET_RAW`, and this namespace enforces `restricted`. The node
agent does the same network setup from the node, so no init container is
injected at all.

```bash
helm install istio-cni istio/cni -n istio-system --wait
kubectl -n istio-system get pods
```

Skipping this produces:

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
  --reuse-values \
  --set istio.enabled=true \
  --wait --timeout 10m

kubectl delete pod -n employee-dev --all     # force re-injection
kubectl get pods -n employee-dev             # expect 2/2
```

`--reuse-values` keeps the passwords and image settings from Phase 4.

The dev overlay leaves `istio.authorizationPolicy.enabled: false` on purpose —
the policy denies everything that is not the ingress gateway, which makes
`kubectl port-forward` straight to a pod fail and is the first thing anyone
tries when debugging.

### 5.5 Reach it through the gateway

```bash
NODEPORT=$(kubectl -n istio-system get svc istio-ingressgateway \
  -o jsonpath='{.spec.ports[?(@.port==80)].nodePort}')
BASE="http://192.168.1.183:$NODEPORT"

curl -s $BASE/readyz
curl -s "$BASE/api/v1/employees?limit=10"
```

Any node IP works — kube-proxy forwards the NodePort from all of them.

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

Left alone deliberately:

| Key | Value | Why |
|---|---|---|
| `postgresql.persistence.storageClass` | `""` | Empty means "cluster default", which Phase 2 provides |
| `namespace.create` | `true` | The chart must own the namespace to set its labels |
| `networkPolicy.enabled` | `true` | Calico enforces these, so they are real here — unlike on kind |
| `metrics.serviceMonitor.enabled` | `false` | No Prometheus Operator |
| `autoscaling.enabled` | `false` (dev) | No metrics-server |

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
