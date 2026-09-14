{{/*
Preflight checks.

These turn a wall of "resource mapping not found ... ensure CRDs are installed
first" into one sentence that says what to do. Helm reports the first `fail`
it hits and stops, so the message has to carry the whole answer.

Evaluated by being included from a template that always renders (NOTES.txt is
not enough — it runs after the manifests are built, which is too late).
*/}}

{{- define "employee-api.preflight" -}}

  {{- /*
    Istio CRDs.

    `.Capabilities.APIVersions` reflects the real cluster during
    `helm install`/`upgrade`, but during `helm template` it is a fixed built-in
    list with no CRDs in it. So the check is gated behind a value that CI sets
    to false when rendering without a cluster.
  */ -}}
  {{- if and .Values.istio.enabled .Values.istio.requireCRDs -}}
    {{- if not (.Capabilities.APIVersions.Has "networking.istio.io/v1") -}}
      {{- fail (printf `
Istio is not installed in this cluster.

This chart creates Gateway, VirtualService, DestinationRule,
PeerAuthentication and AuthorizationPolicy objects, and their CRDs do not
exist yet.

Pick one:

  1. Install Istio (what the chart is designed for):

       helm repo add istio https://istio-release.storage.googleapis.com/charts
       helm repo update
       helm install istio-base istio/base -n istio-system --create-namespace --wait
       helm install istiod istio/istiod -n istio-system --wait
       helm install istio-ingressgateway istio/gateway -n istio-system --wait

  2. Deploy without the mesh (no ingress, mTLS or authorization policy):

       helm upgrade --install %s ./charts/employee-api \
         --namespace %s --set istio.enabled=false

  3. Rendering manifests without a cluster (helm template / CI):

       --set istio.requireCRDs=false

See docs/DEPLOY.md#installing-istio.
` .Release.Name (include "employee-api.namespace" .)) -}}
    {{- end -}}
  {{- end -}}

  {{- /*
    Prometheus Operator CRDs, needed only for the ServiceMonitor.
  */ -}}
  {{- if and .Values.metrics.serviceMonitor.enabled .Values.istio.requireCRDs -}}
    {{- if not (.Capabilities.APIVersions.Has "monitoring.coreos.com/v1") -}}
      {{- fail `
metrics.serviceMonitor.enabled is true but the Prometheus Operator CRDs
(monitoring.coreos.com/v1) are not installed.

Install kube-prometheus-stack, or set:

  --set metrics.serviceMonitor.enabled=false
` -}}
    {{- end -}}
  {{- end -}}

  {{- /*
    An external database needs a host. Caught here rather than as a confusing
    empty DB_HOST in the pod environment.
  */ -}}
  {{- if not .Values.postgresql.enabled -}}
    {{- if not .Values.externalDatabase.host -}}
      {{- fail `
postgresql.enabled is false, so externalDatabase.host must be set:

  --set externalDatabase.host=your-db.example.com
` -}}
    {{- end -}}
  {{- end -}}

{{- end -}}
