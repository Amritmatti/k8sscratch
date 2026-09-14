# Employee API — common tasks.
#
#   make help          list every target
#   make dev           run the stack locally with Docker Compose
#   make deploy        install/upgrade the Helm release
#
# Override any variable on the command line:
#   make build IMAGE_REPO=myuser/employee-api TAG=v1.2.3

SHELL := /bin/bash
.DEFAULT_GOAL := help

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
IMAGE_REPO  ?= YOUR_DOCKERHUB_USERNAME/employee-api
# Default to the current commit hash — the same identifier CI uses.
TAG         ?= $(shell git rev-parse --short=7 HEAD 2>/dev/null || echo dev)
GIT_COMMIT  ?= $(shell git rev-parse HEAD 2>/dev/null || echo unknown)
BUILD_DATE  ?= $(shell date -u +'%Y-%m-%dT%H:%M:%SZ')

RELEASE     ?= employee-api
NAMESPACE   ?= employee-app
CHART       ?= ./charts/employee-api
VALUES      ?=

# Local Compose ports (3000/9090/5432 are often taken).
API_PORT    ?= 3080
export API_PORT

.PHONY: help
help: ## Show this help
	@echo "Employee API — available targets:"
	@echo ""
	@grep -hE '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
	  | sort \
	  | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2}'
	@echo ""
	@echo "Current settings:"
	@echo "  IMAGE_REPO = $(IMAGE_REPO)"
	@echo "  TAG        = $(TAG)"
	@echo "  NAMESPACE  = $(NAMESPACE)"

# ---------------------------------------------------------------------------
# Application
# ---------------------------------------------------------------------------
.PHONY: install
install: ## Install Node dependencies
	cd app && npm ci

.PHONY: test
test: ## Run unit tests (no database needed)
	cd app && npm run test:unit

.PHONY: test-integration
test-integration: ## Run integration tests against the Compose database
	cd app && DB_HOST=127.0.0.1 DB_PORT=55432 DB_NAME=employees \
	  DB_USER=employee_app DB_PASSWORD=local-dev-password LOG_LEVEL=silent \
	  npm run test:integration

.PHONY: audit
audit: ## Fail on high or critical dependency vulnerabilities
	cd app && npm audit --audit-level=high

# ---------------------------------------------------------------------------
# Docker
# ---------------------------------------------------------------------------
.PHONY: build
build: ## Build the image tagged with the commit hash
	docker build \
	  --build-arg GIT_COMMIT=$(GIT_COMMIT) \
	  --build-arg APP_VERSION=$(TAG) \
	  --build-arg BUILD_DATE=$(BUILD_DATE) \
	  -t $(IMAGE_REPO):$(TAG) \
	  -t $(IMAGE_REPO):latest \
	  ./app
	@echo "Built $(IMAGE_REPO):$(TAG)"

.PHONY: push
push: build ## Build and push to Docker Hub
	docker push $(IMAGE_REPO):$(TAG)
	docker push $(IMAGE_REPO):latest

.PHONY: scan
scan: build ## Scan the image for HIGH/CRITICAL vulnerabilities (needs trivy)
	trivy image --severity HIGH,CRITICAL --ignore-unfixed $(IMAGE_REPO):$(TAG)

.PHONY: dev
dev: ## Start the local stack (Postgres + migrations + API)
	docker compose up --build -d
	@echo ""
	@echo "API      http://127.0.0.1:$(API_PORT)/api/v1/employees"
	@echo "Health   http://127.0.0.1:$(API_PORT)/readyz"
	@echo "Metrics  http://127.0.0.1:9091/metrics"

.PHONY: dev-logs
dev-logs: ## Follow local application logs
	docker compose logs -f api

.PHONY: dev-down
dev-down: ## Stop the local stack and delete its data
	docker compose down -v

# ---------------------------------------------------------------------------
# Helm
# ---------------------------------------------------------------------------
.PHONY: lint
lint: ## Lint the chart against every values file
	helm lint $(CHART)
	helm lint $(CHART) -f $(CHART)/values-dev.yaml
	helm lint $(CHART) -f $(CHART)/values-prod.yaml

.PHONY: template
template: ## Render manifests to stdout
	helm template $(RELEASE) $(CHART) \
	  --namespace $(NAMESPACE) \
	  --set image.repository=$(IMAGE_REPO) \
	  --set image.tag=$(TAG) \
	  $(VALUES)

.PHONY: diff
diff: ## Show what an upgrade would change (needs helm-diff plugin)
	helm diff upgrade $(RELEASE) $(CHART) \
	  --namespace $(NAMESPACE) \
	  --set image.repository=$(IMAGE_REPO) \
	  --set image.tag=$(TAG) \
	  $(VALUES)

.PHONY: deploy
deploy: ## Install or upgrade the release
	helm upgrade --install $(RELEASE) $(CHART) \
	  --namespace $(NAMESPACE) \
	  --set image.repository=$(IMAGE_REPO) \
	  --set image.tag=$(TAG) \
	  $(VALUES) \
	  --wait --timeout 10m
	@$(MAKE) status

.PHONY: deploy-dev
deploy-dev: ## Deploy with the development values
	$(MAKE) deploy NAMESPACE=employee-dev VALUES="-f $(CHART)/values-dev.yaml"

.PHONY: status
status: ## Show the state of the release
	@echo "--- release ---"     && helm status $(RELEASE) -n $(NAMESPACE) --show-desc 2>/dev/null | head -20 || true
	@echo "--- pods ---"        && kubectl get pods -n $(NAMESPACE) -o wide
	@echo "--- services ---"    && kubectl get svc -n $(NAMESPACE)
	@echo "--- istio ---"       && kubectl get gateway,virtualservice -n $(NAMESPACE) 2>/dev/null || true

.PHONY: logs
logs: ## Follow application logs in the cluster
	kubectl logs -n $(NAMESPACE) -l app.kubernetes.io/component=api -c api -f --tail=100

.PHONY: smoke
smoke: ## Run the Helm smoke tests against the release
	helm test $(RELEASE) -n $(NAMESPACE) --logs

.PHONY: port-forward
port-forward: ## Forward the service to localhost:8080
	kubectl port-forward -n $(NAMESPACE) svc/$(RELEASE) 8080:80

.PHONY: rollback
rollback: ## Roll back to the previous revision
	helm rollback $(RELEASE) -n $(NAMESPACE) --wait

.PHONY: uninstall
uninstall: ## Remove the release (keeps the namespace and PVC)
	helm uninstall $(RELEASE) -n $(NAMESPACE)

.PHONY: clean
clean: ## Remove local build artefacts
	rm -rf .render app/coverage
	docker compose down -v 2>/dev/null || true
