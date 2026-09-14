{{/*
Shared template helpers.
*/}}

{{/* Base name, overridable. */}}
{{- define "employee-api.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Fully qualified name. Kubernetes object names are capped at 63 characters, so
truncate defensively — a long release name would otherwise produce resources
the API server rejects.
*/}}
{{- define "employee-api.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "employee-api.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/* Labels applied to every object. */}}
{{- define "employee-api.labels" -}}
helm.sh/chart: {{ include "employee-api.chart" . }}
{{ include "employee-api.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: employee-platform
{{- end }}

{{/*
Selector labels. These must never change for an existing release: a
Deployment's selector is immutable, so editing them forces a delete and
recreate.
*/}}
{{- define "employee-api.selectorLabels" -}}
app.kubernetes.io/name: {{ include "employee-api.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "employee-api.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "employee-api.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/* Namespace the release targets. */}}
{{- define "employee-api.namespace" -}}
{{- default .Release.Namespace .Values.namespace.name }}
{{- end }}

{{/* Full image reference. Falls back to the chart appVersion when tag is empty. */}}
{{- define "employee-api.image" -}}
{{- $tag := default .Chart.AppVersion .Values.image.tag }}
{{- if .Values.image.registry }}
{{- printf "%s/%s:%s" .Values.image.registry .Values.image.repository $tag }}
{{- else }}
{{- printf "%s:%s" .Values.image.repository $tag }}
{{- end }}
{{- end }}

{{- define "employee-api.postgresql.fullname" -}}
{{- printf "%s-postgresql" (include "employee-api.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "employee-api.postgresql.image" -}}
{{- printf "%s/%s:%s" .Values.postgresql.image.registry .Values.postgresql.image.repository .Values.postgresql.image.tag }}
{{- end }}

{{/* Secret holding the database credentials. */}}
{{- define "employee-api.secretName" -}}
{{- if .Values.secrets.existingSecret }}
{{- .Values.secrets.existingSecret }}
{{- else }}
{{- printf "%s-secrets" (include "employee-api.fullname" .) }}
{{- end }}
{{- end }}

{{- define "employee-api.configMapName" -}}
{{- printf "%s-config" (include "employee-api.fullname" .) }}
{{- end }}

{{/*
Database host: the bundled StatefulSet's service, or the external host.
*/}}
{{- define "employee-api.dbHost" -}}
{{- if .Values.postgresql.enabled }}
{{- include "employee-api.postgresql.fullname" . }}
{{- else }}
{{- required "externalDatabase.host is required when postgresql.enabled is false" .Values.externalDatabase.host }}
{{- end }}
{{- end }}

{{- define "employee-api.dbPort" -}}
{{- if .Values.postgresql.enabled }}
{{- .Values.postgresql.service.port }}
{{- else }}
{{- .Values.externalDatabase.port }}
{{- end }}
{{- end }}

{{/*
Environment shared by the API pods and the migration Job, so the two can never
drift apart and point at different databases.
*/}}
{{- define "employee-api.env" -}}
- name: NODE_ENV
  value: {{ .Values.config.nodeEnv | quote }}
- name: PORT
  value: {{ .Values.config.port | quote }}
- name: METRICS_PORT
  value: {{ .Values.config.metricsPort | quote }}
- name: DB_HOST
  value: {{ include "employee-api.dbHost" . | quote }}
- name: DB_PORT
  value: {{ include "employee-api.dbPort" . | quote }}
- name: DB_NAME
  valueFrom:
    secretKeyRef:
      name: {{ include "employee-api.secretName" . }}
      key: DB_NAME
- name: DB_USER
  valueFrom:
    secretKeyRef:
      name: {{ include "employee-api.secretName" . }}
      key: DB_USER
- name: DB_PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ include "employee-api.secretName" . }}
      key: DB_PASSWORD
- name: POD_NAME
  valueFrom:
    fieldRef:
      fieldPath: metadata.name
- name: POD_NAMESPACE
  valueFrom:
    fieldRef:
      fieldPath: metadata.namespace
{{- end }}
