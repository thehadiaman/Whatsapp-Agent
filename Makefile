SHELL := /bin/bash
.DEFAULT_GOAL := help

# Read .env as make variables and export them to every command. Values given
# on the command line win, e.g. when port 3000 is taken:
#   make dev WEB_PORT=3300 PUBLIC_APP_URL=http://localhost:3300
-include .env
export

# Every app runs from its own folder (pnpm --filter), so a relative storage
# path would give the API and the worker different directories. Resolve it
# from the repository root once, here.
MEDIA_STORAGE_DIR := $(abspath $(or $(MEDIA_STORAGE_DIR),.data/media))

.PHONY: help setup infra db dev check test test-int e2e eval eval-mock load-test infra-check backup-test rehearsal readme-screenshots images up down reset

help: ## List targets
	@grep -hE '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*## "}; {printf "  %-12s %s\n", $$1, $$2}'

setup: ## Install dependencies, enable git hooks, create .env, pull images (needs internet once)
	@[ -f .env ] || { cp .env.example .env; echo "created .env from .env.example"; }
	pnpm install --frozen-lockfile
	git config core.hooksPath .githooks
	docker compose pull postgres redis

infra: ## Start Postgres and Redis and wait until healthy
	docker compose up -d --wait postgres redis

db: infra ## Create database roles, apply migrations, seed demo data (idempotent)
	pnpm db:provision && pnpm --filter @app/api build && pnpm --filter @app/api run seed

dev: db ## Run the product in mock mode: infra in Docker, apps on the host in watch mode
	pnpm dev

check: ## Format check, lint, typecheck, unit tests, commit-message tests
	pnpm format:check && pnpm lint && pnpm typecheck && pnpm test

test: ## Unit tests only
	pnpm test

test-int: infra ## Integration tests against the Compose Postgres and Redis
	pnpm test:int

e2e: db ## Playwright end-to-end tests at 1440 and 390 px (builds every app first)
	pnpm build && pnpm --filter @app/web run e2e

eval: infra ## Evals against live Bedrock: needs AWS credentials, costs money (docs/EVALS.md)
	pnpm eval

eval-mock: infra ## The same evals offline, with the mock model: checks the machinery, not quality
	pnpm eval:mock

load-test: ## 1,000 messages with faults into a running stack (start make dev first; docs/LOAD-TEST.md)
	pnpm load-test

infra-check: ## Terraform fmt/validate/test (mocked AWS) and shellcheck on the deploy scripts; no AWS account
	scripts/infra-check.sh

backup-test: infra ## Back up and restore the app_test database (run make test-int first)
	scripts/backup-restore.test.sh

rehearsal: ## The production stack locally: images, Caddy, TLS, WebSocket, backups and a full restore (offline)
	scripts/prod-rehearsal.sh

readme-screenshots: infra ## Regenerate docs/images from a fresh seed and check the README demo (stop make dev first)
	scripts/readme-screenshots.sh

images: ## Build all production images for this machine's architecture
	docker compose --profile app build

up: ## Run everything from production images (mock mode)
	docker compose --profile app up -d --build --wait

down: ## Stop all containers, keep data
	docker compose --profile app down

reset: ## Stop all containers and delete local data volumes
	docker compose --profile app down --volumes
