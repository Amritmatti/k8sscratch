# Security

The DevSecOps controls in this project, what each one actually prevents, and
how to check it is working. A control you cannot verify is a comment, not a
control.

---

## Layers

```
  Pipeline    gitleaks · npm audit · hadolint · Trivy image · Trivy config · kubeconform
      │
  Image       multi-stage · no dev deps · non-root · pinned base · SBOM + provenance
      │
  Pod         runAsNonRoot · readOnlyRootFilesystem · drop ALL caps · seccomp · no SA token
      │
  Namespace   PodSecurity "restricted" enforced by the API server
      │
  Mesh        mTLS STRICT · default-deny AuthorizationPolicy · outlier ejection
      │
  Network     NetworkPolicy — egress to DNS + Postgres only
      │
  App         Zod validation · parameterised SQL · Helmet · rate limit · redacted logs
      │
  Data        CHECK constraints · least-privilege DB user · Secret-sourced credentials
```

The point of the repetition is that no single failure is fatal. A missing
sidecar still leaves NetworkPolicy. A bypassed API still meets database
constraints.

---

## Pipeline

| Check | Tool | Blocks on |
|---|---|---|
| Committed credentials | Gitleaks, full history | Any finding |
| Vulnerable dependencies | `npm audit` | HIGH / CRITICAL |
| Dockerfile practice | Hadolint | Warning and above |
| Image CVEs | Trivy | HIGH / CRITICAL **with a fix available** |
| Manifest misconfiguration | Trivy config | Reported, not blocking |
| Manifest validity | kubeconform (+ Istio CRD schemas) | Invalid manifests |

`--ignore-unfixed` on the image scan is deliberate: blocking on a CVE with no
available patch stops all deploys, including the one that would fix something
else. Those are tracked, not gated.

Gitleaks scans the **whole history** because a credential that was committed and
later removed is still in the history and still needs rotating.

The security workflow also runs weekly. New CVEs are published against code
that has not changed; a scan triggered only by commits will never see them.

---

## Image

| Control | Why |
|---|---|
| Multi-stage build | Compilers and dev dependencies never reach the final image |
| `npm ci --omit=dev` | Only production dependencies, exactly as pinned |
| `--ignore-scripts` | Blocks dependency install hooks — a common supply-chain path |
| `USER node` (uid 1000) | No root inside the container |
| Alpine base | Small package surface |
| `dumb-init` PID 1 | Correct signal handling; also means no shell as PID 1 |
| SBOM + provenance | You can answer "which library version shipped" after the fact |

Verify:

```bash
docker run --rm employee-api:dev id
# uid=1000(node) gid=1000(node)

trivy image --severity HIGH,CRITICAL --ignore-unfixed employee-api:dev
```

---

## Pod

```yaml
securityContext:
  runAsNonRoot: true
  runAsUser: 1000
  seccompProfile: { type: RuntimeDefault }
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: true
  capabilities: { drop: [ALL] }
automountServiceAccountToken: false
```

| Control | Prevents |
|---|---|
| `runAsNonRoot` | Container processes running as uid 0 |
| `readOnlyRootFilesystem` | Writing a payload anywhere but the explicit `/tmp` emptyDir |
| `drop: [ALL]` | Every Linux capability, including `NET_RAW` (packet crafting, ARP spoofing) |
| `allowPrivilegeEscalation: false` | `setuid` binaries gaining privileges |
| `seccompProfile: RuntimeDefault` | ~44 dangerous syscalls |
| `automountServiceAccountToken: false` | A compromised container having cluster credentials at all |

The namespace is labelled `pod-security.kubernetes.io/enforce: restricted`, so
the API server rejects any pod that does not meet this bar — including one
added later by someone who skipped the chart.

Verify:

```bash
POD=$(kubectl get pod -n employee-app -l app.kubernetes.io/component=api -o jsonpath='{.items[0].metadata.name}')

kubectl exec -n employee-app $POD -c api -- touch /proof
#   touch: /proof: Read-only file system

kubectl exec -n employee-app $POD -c api -- ls /var/run/secrets/kubernetes.io/serviceaccount
#   No such file or directory  <- correct
```

Both were confirmed in the local container, which mirrors the same settings.

---

## Mesh (Istio)

### mTLS STRICT

```yaml
kind: PeerAuthentication
spec:
  mtls: { mode: STRICT }
```

Every connection between workloads must present a valid Istio-issued
certificate. Plaintext is refused. Istio's default is `PERMISSIVE`, which
accepts both — useful during migration, but it means an unencrypted path keeps
working silently, which is exactly the situation you were trying to leave.

### Default-deny authorization

Four policies, in order of effect:

1. **`deny-all`** — an `AuthorizationPolicy` with an empty `spec: {}`. Nothing
   is permitted unless another rule allows it.
2. **`allow-gateway`** — the ingress gateway, identified by its SPIFFE
   principal, may call `/api/*`, `/healthz`, `/readyz`. Identity from the mTLS
   certificate, not an IP, so another pod cannot impersonate it.
3. **`allow-metrics`** — only the monitoring namespaces, only `GET`, only port
   9090.
4. **`allow-probes`** — kubelet probes arrive from the node, outside the mesh,
   with no peer identity. Without this rule the sidecar rejects them and every
   pod fails readiness.

That fourth policy is the one people forget; the symptom is pods that never
become Ready with no obvious cause.

Verify:

```bash
istioctl x describe pod -n employee-app $POD
#   ... Effective PeerAuthentication: STRICT

# From a pod in another namespace — should be denied
kubectl run probe --rm -it --image=curlimages/curl --restart=Never -- \
  curl -s -o /dev/null -w '%{http_code}' \
  http://employee-api.employee-app.svc.cluster.local/api/v1/employees
#   403
```

---

## Network

NetworkPolicy is enforced by the CNI, so it holds even if a sidecar is missing,
misconfigured or bypassed.

**API pods** — egress restricted to:
- DNS (`kube-system`, 53) — without it the database name will not resolve
- PostgreSQL, by pod selector
- The Istio control plane (15012, 15010)

Nothing else. A compromised API pod cannot reach the internet or another
service in the cluster.

**Database pods** — ingress only from API pods and the migration Job. Nothing
else in the namespace, nothing in any other namespace.

> **Check your CNI actually enforces this.** Calico, Cilium and Antrea do.
> kind's default CNI does **not** — the objects are accepted by the API server
> and silently ignored, which looks identical to working.

```bash
kubectl exec -n employee-app $POD -c api -- \
  node -e "fetch('https://example.com').then(()=>console.log('REACHED - not enforced')).catch(()=>console.log('blocked - correct'))"
```

---

## Application

| Control | Detail |
|---|---|
| Input validation | Zod schemas, `.strict()` so unknown fields are rejected |
| SQL injection | Every value bound as a parameter; `ORDER BY` resolved through a fixed allow-list, since a column name cannot be parameterised |
| Security headers | Helmet: CSP, `nosniff`, `DENY` framing, HSTS in production |
| Rate limiting | 120/min per IP on `/api`; probes exempt |
| Body size | 100 kB cap |
| Error handling | Raw driver errors never returned — they leak schema details |
| Log redaction | Authorization headers, cookies, passwords **and `dob`** are redacted at the logger |
| Slow-loris | `headersTimeout` 20s, `requestTimeout` 30s |
| Fail fast | Refuses to start in production without database credentials |

Date of birth is redacted from logs deliberately: employee records are personal
data, and a log aggregator is usually a much softer target than the database.

---

## Data

```sql
CONSTRAINT employees_dob_realistic  CHECK (dob < CURRENT_DATE AND dob > CURRENT_DATE - INTERVAL '120 years'),
CONSTRAINT employees_doj_after_dob  CHECK (doj > dob),
CONSTRAINT employees_name_not_blank CHECK (length(btrim(name)) BETWEEN 1 AND 120),
```

Validation in the application protects the user experience; constraints here
protect the data from anything that arrives by another route — a migration, a
manual fix, a future service. Two integration tests write directly to the
database to prove they fire.

---

## Secrets

### How it works now

`values.yaml` holds the credentials and the chart creates a Kubernetes Secret
from them, because that is what was asked for. The values file is the boundary:
**it is exactly as private as the file itself.**

A Kubernetes Secret is base64-encoded, not encrypted. Anyone with `get secrets`
in the namespace can read it.

### For anything real

Three options, best first:

**1. External secret manager** — the chart never sees the credential:

```yaml
secrets:
  existingSecret: employee-api-db-credentials
```

Create that Secret with External Secrets Operator (AWS Secrets Manager, Vault,
GCP Secret Manager) or Sealed Secrets. `values-prod.yaml` is already set up this
way and deliberately contains no passwords.

**2. Inject at deploy time** — the value lives in your CI's secret store:

```bash
helm upgrade --install employee-api ./charts/employee-api \
  --set secrets.dbPassword="$DB_PASSWORD"
```

**3. Encrypt the values file** — SOPS or git-crypt, decrypted in the pipeline.

### Regardless

- Enable [encryption at rest](https://kubernetes.io/docs/tasks/administer-cluster/encrypt-data/)
  for etcd.
- Restrict `get secrets` with RBAC.
- Rotate on a schedule and after anyone with access leaves.
- Never log them. The logger redacts `password` and `DB_PASSWORD` by path.

---

## Known limitations

Stated plainly rather than left for you to discover:

| Limitation | Impact | Fix |
|---|---|---|
| Secrets in `values.yaml` by default | Plaintext in git if committed | Use `existingSecret` |
| Bundled PostgreSQL is single-replica | No HA, no backups, no PITR | Managed database or CloudNativePG |
| No authentication on the API | Anyone who reaches the gateway can read and write employee data | Add an Istio `RequestAuthentication` with JWT, or an OIDC proxy |
| No audit log of data changes | Cannot answer who changed a record | Add an audit table or trigger |
| Images not signed | No cryptographic provenance at deploy time | Cosign + a Kyverno/Gatekeeper policy requiring signatures |
| NetworkPolicy needs a capable CNI | Silently inert on some clusters | Verify, then test with the command above |

The missing API authentication is the significant one for a system holding
personal data. It was not in the brief, so it is not implemented — but it should
be before this handles anything real.

---

## Reporting

Do not open a public issue for a vulnerability. Contact the platform team
directly with reproduction steps.
