#!/usr/bin/env bash
#
# Install Istio into the current cluster using Helm.
#
# Uses Helm rather than istioctl so there is nothing extra to download — if you
# can run this chart, you can run this.
#
#   ./scripts/install-istio.sh              # install
#   ./scripts/install-istio.sh --uninstall  # remove
#   ISTIO_VERSION=1.24.2 ./scripts/install-istio.sh
#
# Three releases, in this order, because each depends on the last:
#   istio-base            the CRDs
#   istiod                the control plane
#   istio-ingressgateway  the Envoy that terminates inbound traffic

set -euo pipefail

ISTIO_VERSION="${ISTIO_VERSION:-}"     # empty = latest from the repo
ISTIO_NAMESPACE="${ISTIO_NAMESPACE:-istio-system}"
REPO_URL="https://istio-release.storage.googleapis.com/charts"

log()  { printf '\n\033[36m==> %s\033[0m\n' "$*"; }
ok()   { printf '    \033[32m%s\033[0m\n' "$*"; }
warn() { printf '    \033[33m%s\033[0m\n' "$*"; }
die()  { printf '\n\033[31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

command -v helm    >/dev/null 2>&1 || die "helm is not installed."
command -v kubectl >/dev/null 2>&1 || die "kubectl is not installed."

kubectl cluster-info >/dev/null 2>&1 \
  || die "Cannot reach a cluster. Check 'kubectl config current-context'."

CONTEXT="$(kubectl config current-context)"

# ---------------------------------------------------------------------------
if [ "${1:-}" = "--uninstall" ]; then
  log "Removing Istio from context: $CONTEXT"
  read -r -p "    This affects the whole cluster. Continue? [y/N] " reply
  [ "$reply" = "y" ] || [ "$reply" = "Y" ] || die "Cancelled."

  for release in istio-ingressgateway istiod istio-base; do
    if helm status "$release" -n "$ISTIO_NAMESPACE" >/dev/null 2>&1; then
      helm uninstall "$release" -n "$ISTIO_NAMESPACE"
      ok "removed $release"
    fi
  done
  warn "CRDs are left in place on purpose; removing them deletes every"
  warn "Gateway/VirtualService in the cluster. To remove them anyway:"
  warn "  kubectl get crd -o name | grep istio.io | xargs kubectl delete"
  exit 0
fi

# ---------------------------------------------------------------------------
log "Installing Istio into context: $CONTEXT"
kubectl get nodes -o wide | sed 's/^/    /'

VERSION_ARG=()
if [ -n "$ISTIO_VERSION" ]; then
  VERSION_ARG=(--version "$ISTIO_VERSION")
  ok "pinning to Istio $ISTIO_VERSION"
else
  warn "no ISTIO_VERSION set — installing the latest published chart"
fi

log "Adding the Istio chart repository"
helm repo add istio "$REPO_URL" >/dev/null 2>&1 || true
helm repo update istio >/dev/null
ok "repository ready"

log "1/3  istio-base (CRDs)"
helm upgrade --install istio-base istio/base \
  -n "$ISTIO_NAMESPACE" --create-namespace \
  "${VERSION_ARG[@]}" --wait --timeout 5m
ok "CRDs installed"

log "2/3  istiod (control plane)"
helm upgrade --install istiod istio/istiod \
  -n "$ISTIO_NAMESPACE" \
  "${VERSION_ARG[@]}" --wait --timeout 10m
ok "control plane ready"

log "3/3  istio-ingressgateway"
helm upgrade --install istio-ingressgateway istio/gateway \
  -n "$ISTIO_NAMESPACE" \
  "${VERSION_ARG[@]}" --wait --timeout 5m
ok "ingress gateway ready"

# ---------------------------------------------------------------------------
log "Verifying"
kubectl get pods -n "$ISTIO_NAMESPACE" | sed 's/^/    /'
echo
printf '    Istio CRDs registered: %s\n' "$(kubectl get crd -o name | grep -c istio.io)"

SVC_TYPE="$(kubectl get svc istio-ingressgateway -n "$ISTIO_NAMESPACE" \
  -o jsonpath='{.spec.type}' 2>/dev/null || echo unknown)"
EXTERNAL_IP="$(kubectl get svc istio-ingressgateway -n "$ISTIO_NAMESPACE" \
  -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || true)"

echo
if [ -n "$EXTERNAL_IP" ]; then
  ok "gateway external IP: $EXTERNAL_IP"
else
  warn "gateway Service is type $SVC_TYPE with no external IP."
  warn "On a bare-metal or VM cluster there is no load balancer, so either:"
  warn ""
  warn "  a) port-forward it when you need it:"
  warn "       kubectl -n $ISTIO_NAMESPACE port-forward svc/istio-ingressgateway 8080:80"
  warn ""
  warn "  b) expose it as a NodePort:"
  warn "       kubectl -n $ISTIO_NAMESPACE patch svc istio-ingressgateway \\"
  warn "         -p '{\"spec\":{\"type\":\"NodePort\"}}'"
  warn ""
  warn "  c) install MetalLB to get real LoadBalancer addresses."
fi

log "Next"
cat <<'EOF'
    helm upgrade --install employee-api ./charts/employee-api \
      --namespace employee-app \
      --set secrets.dbPassword="$(openssl rand -base64 24)" \
      --set secrets.postgresPassword="$(openssl rand -base64 24)" \
      --wait --timeout 10m

    Note: --namespace, and NOT --create-namespace. The chart creates the
    namespace itself so it can apply the istio-injection and PodSecurity
    labels; letting Helm pre-create it causes an ownership conflict.
EOF
