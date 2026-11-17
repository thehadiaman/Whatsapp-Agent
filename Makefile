SHELL := /bin/bash
.DEFAULT_GOAL := help

# Export every variable in .env to the commands below (when the file exists).
LOAD_ENV := set -a; [ -f .env ] && . ./.env; set +a;

.PHONY: help setup infra db dev check test test-int images up down reset

help: ## List targets
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*## "}; {printf "  %-10s %s\n", $$1, $$2}'

setup: ## Install dependencies, enable git hooks, create .env, pull images (needs internet once)
	@[ -f .env ] || { cp .env.example .env; echo "created .env from .env.example"; }
	pnpm install --frozen-lockfile
	git config core.hooksPath .githooks
	docker compose pull postgres redis

infra: ## Start Postgres and Redis and wait until healthy
	docker compose up -d --wait postgres redis

db: infra ## Create database roles, apply migrations, seed demo data (idempotent)
	$(LOAD_ENV) pnpm db:provision && pnpm --filter @app/api build && pnpm --filter @app/api run seed

dev: db ## Run the product in mock mode: infra in Docker, apps on the host in watch mode
	$(LOAD_ENV) pnpm dev

check: ## Format check, lint, typecheck, unit tests, commit-message tests
	$(LOAD_ENV) pnpm format:check && pnpm lint && pnpm typecheck && pnpm test

test: ## Unit tests only
	$(LOAD_ENV) pnpm test

test-int: infra ## Integration tests against the Compose Postgres and Redis
	$(LOAD_ENV) pnpm test:int

images: ## Build all production images for this machine's architecture
	docker compose --profile app build

up: ## Run everything from production images (mock mode)
	docker compose --profile app up -d --build --wait

down: ## Stop all containers, keep data
	docker compose --profile app down

reset: ## Stop all containers and delete local data volumes
	docker compose --profile app down --volumes
