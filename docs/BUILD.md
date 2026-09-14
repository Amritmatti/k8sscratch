# Building

How the container image is produced, locally and in CI.

---

## The short version

```bash
# From the repository root
docker build -t youruser/employee-api:$(git rev-parse --short=7 HEAD) ./app
```

Or through the task runner, which fills in the build arguments for you:

```bash
make build IMAGE_REPO=youruser/employee-api
```
```powershell
.\scripts\task.ps1 build -ImageRepo youruser/employee-api
```

---

## Build arguments

The Dockerfile takes three, all optional, all purely for provenance:

| Argument | Default | Ends up in |
|---|---|---|
| `GIT_COMMIT` | `unknown` | `GIT_COMMIT` env var, `org.opencontainers.image.revision` label |
| `APP_VERSION` | `dev` | `APP_VERSION` env var, `...image.version` label |
| `BUILD_DATE` | `unknown` | `...image.created` label |

They are surfaced at runtime by `GET /api/v1`:

```json
{ "service": "employee-api", "version": "b39edf5", "commit": "b39edf5..." }
```

That endpoint is how you answer "what is actually running in production right
now" without guessing from a tag.

```bash
docker build \
  --build-arg GIT_COMMIT=$(git rev-parse HEAD) \
  --build-arg APP_VERSION=$(git rev-parse --short=7 HEAD) \
  --build-arg BUILD_DATE=$(date -u +'%Y-%m-%dT%H:%M:%SZ') \
  -t youruser/employee-api:$(git rev-parse --short=7 HEAD) \
  ./app
```

---

## What the Dockerfile does

Two stages:

1. **`deps`** — installs production dependencies only, with `npm ci` against
   the lockfile so the build is reproducible. `--ignore-scripts` blocks
   dependency install hooks, a well-worn supply-chain attack path.
2. **`runtime`** — copies `node_modules` and the source into a clean
   `node:22-alpine`, applies OS patches, adds `dumb-init`, removes npm, and
   drops to uid 1000.

Decisions worth knowing about:

| Choice | Reason |
|---|---|
| Copy `package.json` before the source | Dependency layer stays cached, so a code change rebuilds in seconds |
| `npm ci --omit=dev` | No compilers, linters or test frameworks in the shipped image |
| `dumb-init` as PID 1 | Node as PID 1 has no default `SIGTERM` handler, so graceful shutdown would never run and every pod termination would be a hard kill after the grace period |
| `NODE_OPTIONS=--max-old-space-size=384` | Keeps the V8 heap inside the container memory limit so the kernel OOM killer does not take the process out without an error you can read |
| No `apk` packages beyond `dumb-init` | Every added package is more CVE surface to triage |
| `apk upgrade` | Picks up OS patches released after the base image was tagged. Without it the image inherits whatever `libssl`/`libcrypto` the base shipped with, which is how an image that installs almost nothing still reports HIGH findings |
| **npm and corepack deleted** | The runtime entrypoint is `node src/server.js`; npm is never invoked after the build. Its ~600 bundled dependencies accounted for *every* Node-level CVE this image reported. Removing it also takes a package manager away from anyone who gets code execution in the container |
| `USER 1000:1000`, not `USER node` | With `runAsNonRoot: true` the kubelet cannot verify a *named* user is non-root and refuses to start the container unless `runAsUser` is also set. A numeric UID removes that dependency |

The `HEALTHCHECK` is informational — Kubernetes ignores it and uses the probes
defined in the Helm chart. It is written in JSON exec form; the shell form wraps
every check in `/bin/sh -c` and is flagged by hadolint DL3025.

### Vulnerability posture

Measured on the built image with Trivy 0.70:

| | HIGH/CRITICAL (fixable) |
|---|---|
| Before `apk upgrade` + npm removal | **13** — 2 OS (`libssl3`, `libcrypto3`), 11 from npm's bundled dependencies |
| After | **0** |

None of the 11 Node findings were in this application's dependencies; every one
sat under `/usr/local/lib/node_modules/npm/`. Verify the attribution yourself
with:

```bash
trivy image --scanners vuln --severity HIGH,CRITICAL --ignore-unfixed \
  --format json employee-api:scan \
  | jq -r '.Results[].Vulnerabilities[]? | "\(.PkgPath // "os") \(.PkgName)"'
```

A finding under `app/node_modules/` *is* yours and needs the dependency
updating. One under `usr/local/lib/node_modules/npm/` is not — and should no
longer appear at all.

---

## CI: build and push

`.github/workflows/docker-build-push.yml` does exactly one job: build the image
and push it to Docker Hub tagged with the commit hash.

### Triggers

| Event | Behaviour |
|---|---|
| Push to `main` / `master` / `develop` | Build and push |
| Push a `v*` tag | Build and push, plus the version tag |
| Pull request | Build only — verifies the Dockerfile without publishing |
| Manual dispatch | Build, push optional |

Only changes under `app/**` trigger it. Editing the Helm chart does not produce
a new image, because it does not change one.

### Tags produced

For commit `b39edf5a1c2...` on `main`:

```
youruser/employee-api:b39edf5                    <- short commit hash
youruser/employee-api:b39edf5a1c2d3e4f5...       <- full commit hash
youruser/employee-api:latest                     <- default branch only
```

**Deploy the commit-hash tag, never `latest`.** A hash is immutable: it always
means one build of one commit. `latest` moves, so you cannot tell what is
running, and a node that restarts and re-pulls can silently change version
underneath you.

### Required secrets

In **Settings → Secrets and variables → Actions**:

| Name | Type | Value |
|---|---|---|
| `DOCKERHUB_USERNAME` | Secret | Your Docker Hub account name |
| `DOCKERHUB_TOKEN` | Secret | An access token, **not** your password |
| `DOCKERHUB_REPOSITORY` | Variable (optional) | Defaults to `<username>/employee-api` |

Create the token at **hub.docker.com → Account Settings → Personal access
tokens** with *Read & Write*. A token can be scoped and revoked on its own; your
password cannot.

### Also in the workflow

- **Multi-architecture**: `linux/amd64` and `linux/arm64` via QEMU + Buildx, so
  the image runs on Graviton and Apple Silicon as well as x86.
- **Layer caching**: `type=gha` reuses unchanged layers between runs.
- **Provenance and SBOM**: `provenance: true`, `sbom: true` attach build
  attestations, so you can answer "which version of which library is in this
  image" after the fact.
- **Job summary**: prints the digest and a ready-to-paste `helm upgrade`
  command for that exact build.

---

## CI: tests and security

`.github/workflows/ci-security.yml` is deliberately separate so the build stays
fast and a scanner failure does not block producing an image for a branch you
are debugging.

| Job | Tool | Fails the build on |
|---|---|---|
| `test` | `node --test` + a real Postgres service container | Any failing test |
| `dependencies` | `npm audit` | HIGH or CRITICAL advisories |
| `secrets-scan` | Gitleaks (full history) | Any committed credential |
| `dockerfile-lint` | Hadolint | Warnings and above |
| `image-scan` | Trivy | HIGH/CRITICAL CVEs that have a fix available |
| `helm-validate` | `helm lint`, `kubeconform`, Trivy config | Invalid chart or manifests |

It also runs weekly on a schedule, because new CVEs are published against code
that has not changed — a scan triggered only by commits will miss them.

Results upload as SARIF to the repository's **Security** tab.

---

## Reproducibility

`npm ci` requires `app/package-lock.json` and installs exactly what it pins.
Commit the lockfile. If it is missing, the Dockerfile falls back to
`npm install` and prints a warning — the build will succeed but two builds of
the same commit can differ.

```bash
cd app && npm install        # updates the lockfile after changing package.json
git add package-lock.json
```
