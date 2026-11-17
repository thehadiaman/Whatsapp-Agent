# Decisions

Each entry records what was chosen, what was rejected, and why. Newest phase last. Proposals still waiting for approval are at the end.

## Phase 0: foundations (2026-11-17)

### D-001 pnpm workspaces, no build orchestrator

- **Chosen:** plain pnpm workspaces; root scripts run `pnpm -r`.
- **Rejected:** Turborepo or Nx.
- **Why:** five packages build in well under a minute. An orchestrator's caching would be one more tool to explain for little gain today. Revisit if CI approaches its ten-minute budget.

### D-002 TypeScript 6.0, not 7.0

- **Chosen:** `typescript@6.0.3`, strict, plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.
- **Rejected:** TypeScript 7.0 (the native port, current `latest`).
- **Why:** typescript-eslint 8.72 supports TypeScript `<6.1`, and the Nest CLI bundles 6.0. Type-aware linting matters more than faster compiles. Revisit when typescript-eslint supports 7.

### D-003 ESLint 9, not 10

- **Chosen:** `eslint@9.39.5` with `typescript-eslint` strict-type-checked rules. Every `eslint-disable` comment must give a reason.
- **Rejected:** ESLint 10.
- **Why:** the plugins inside `eslint-config-next` (react, jsx-a11y, import) declare peer support only up to ESLint 9. A linter that might crash on new rule APIs is worse than one major version behind.

### D-004 ESM everywhere; NestJS 12

- **Chosen:** every package is `"type": "module"` with NodeNext resolution and explicit `.js` import extensions.
- **Rejected:** CommonJS for the API.
- **Why:** NestJS 12 itself ships as ESM, so mixing module systems would only add interop edges.

### D-005 Shared package is consumed as built output

- **Chosen:** `packages/shared` compiles to `dist/`, and consumers import the build. Root scripts build it first.
- **Rejected:** importing TypeScript source across packages, and TypeScript project references.
- **Why:** source imports break `tsc` emit (`rootDir`) and Node at runtime. Project references need `tsc -b`, which neither the Next nor the Nest CLI uses.
- **Cost:** one extra build step before typecheck and test.

### D-006 Vitest for every package

- **Chosen:** Vitest. NestJS tests use `unplugin-swc` so decorator metadata (needed for dependency injection) is emitted.
- **Rejected:** Jest, Nest's default.
- **Why:** one test runner across the repo, native ESM, faster startup.

### D-007 Integration tests use Compose and CI service containers

- **Chosen:** locally, tests run against the Compose Postgres and Redis on a separate database (`app_test`) and Redis index (1). CI uses service containers with the same images.
- **Rejected:** Testcontainers.
- **Why:** it would add a dependency and per-suite container start time, and Compose already defines the images.
- **Cost:** suites share one database, so phase 1 adds per-suite schema isolation.

### D-008 Development: infrastructure in Docker, apps on the host

- **Chosen:** `make dev` starts Postgres and Redis in Docker and runs the apps on the host in watch mode. `make up` runs everything from the production images.
- **Rejected:** all-in-container development.
- **Why:** bind-mounted `node_modules` across host and container are slow and fragile, especially for native binaries such as SWC and Next.
- **Cost:** the host needs Node 24 and pnpm (documented in `make setup`).

### D-009 Postgres 18 with pgvector 0.8.7; Redis 8.8

- **Chosen:** `pgvector/pgvector:0.8.7-pg18-trixie` and `redis:8.8.4-alpine`, exact tags.
- **Why:**
  - Current stable versions, and the same images locally, in CI and in production.
  - Host ports 55432 and 56379 are bound to `127.0.0.1`, so they neither collide with other local databases nor listen on the LAN.

### D-010 Structured logging with pino

- **Chosen:** `@app/shared` exports `createLogger` (pino, JSON, ISO time, `service` field), and NestJS framework logs are routed through it.
- **Rejected:** Nest's built-in JSON console logger, and a hand-written logger.
- **Why:** pino is the conventional Node choice, and it supports redaction paths, which the brief's masking of phone numbers and message text needs.
- **Next:** request and conversation IDs arrive in phase 1, masking in phase 2.

### D-011 Liveness and readiness are separate

- **Chosen:** `/health` checks nothing. `/ready` checks Postgres and Redis in parallel with a one-second timeout each, and returns 503 naming each failing dependency.
- **Why:**
  - A database outage should take the API out of rotation, not restart it.
  - The response never includes error text, which can reveal hosts or users; that goes to the log.

### D-012 `APP_MODE` defaults to `mock`

- **Chosen:** environment is validated with zod at startup, and an unset `APP_MODE` means mock.
- **Why:**
  - A missing variable must never cause a paid or outbound call.
  - Validation errors name the variable and the rule, never the value, because values are often secrets.

### D-013 Supply-chain hygiene

- **Chosen:**
  - Exact versions throughout.
  - pnpm `minimumReleaseAge` of two days.
  - Install scripts allowed only for `@swc/core` and `esbuild`.
  - GitHub Actions pinned to commit SHAs.
- **Rejected:** pnpm's automatic `minimumReleaseAgeExclude` for releases published the day before.
- **Why:** exempting brand-new releases defeats the guard. So NestJS is pinned to 12.5.0 instead of the day-old 12.5.1, and typescript-eslint to 8.72.2.

### D-014 Production images

- **Chosen:**
  - One parametrised Dockerfile for the Node services; `pnpm deploy --prod` produces a pruned bundle.
  - Next.js standalone output for the web app.
  - Base image `node:24.22.3-trixie-slim`, running as the `node` user.
- **Rejected:** Alpine.
- **Why:** glibc avoids musl incompatibilities in native modules (SWC, sharp, later audio tooling).
- **Cost:** images are 350–390 MB. Slimming is deferred until memory or pull time on the 4 GB instance says it matters.

### D-015 CI shape

- **Chosen:** three parallel jobs:
  - commit policy;
  - format, lint, typecheck, unit and integration tests;
  - arm64 image builds on native `ubuntu-24.04-arm` runners with layer caching.
- **Rejected:** QEMU emulation on x86 runners.
- **Why:** emulated Next.js builds would break the ten-minute budget. Images are built but not pushed; pushing to ECR arrives with deployment in phase 9.

### D-016 One commit-message checker for hook and CI

- **Chosen:** `scripts/commit-msg-check.sh` is called by `.githooks/commit-msg` and by `scripts/check-commit-range.sh` in CI.
  - It rejects AI attribution lines and requires Conventional Commits.
  - CI also rejects commits whose author or committer names Claude or Anthropic.
  - `pnpm install` sets `core.hooksPath`.
- **Why:** the local and CI rules cannot drift apart. The checker has its own tests.

### D-017 Next.js telemetry disabled

- **Chosen:** `NEXT_TELEMETRY_DISABLED=1` in `.env.example`, the web image and CI.
- **Why:** Next.js sends anonymous telemetry by default, and mock mode must make zero outbound calls.

## Proposed, awaiting approval

These came out of the first review of the brief. Nothing below is built yet.

- **P-01 Per-channel WhatsApp gateway.**
  - `APP_MODE` stays the local preset. In production each tenant's channel stores its Graph API base URL and secret reference, so the real number (Meta) and the public demo (simulator) share one deployment.
  - Separate webhook routes per source feed one pipeline.
- **P-02 Per-conversation ordering without BullMQ Pro.**
  - BullMQ's per-group FIFO ("Groups") is Pro-only.
  - Instead, a Postgres outbox with a per-conversation sequence; jobs only say "drain conversation X" (deduplicated by job ID); the worker holds a per-conversation advisory lock.
- **P-03 Accounts without email in v1.** Copyable invite and reset links; the platform admin creates tenants; no self-signup, and no SES.
- **P-04 Manual WhatsApp credentials.** The owner enters phone number ID, WABA ID and a system-user token, stored encrypted. Embedded Signup is deferred.
- **P-05 Templates.** One "reopen conversation" template per tenant per language, referenced by name. No template builder.
- **P-06 Knowledge formats.** Text PDFs, DOCX, Markdown and plain text, CSV catalogue (one chunk per product), FAQ entries in the app. No OCR.
- **P-07 Customer images and documents.** Stored and shown in the inbox; the assistant acknowledges them and offers a person. No vision in v1.
- **P-08 Platform admin versus RLS.** A separate database role with narrow grants for admin views, and a single `SECURITY DEFINER` lookup for webhook routing (phone number ID to tenant).
- **P-09 Voice language ID.**
  - Transcribe requires at least two candidate languages and recommends 30+ seconds of speech.
  - Once a conversation's language is known, transcribe with that code; auto-detect only the first voice note.
- **P-10 Evals.**
  - Deterministic checks for handoff and declines; an LLM judge for groundedness and language, spot-checked by hand.
  - Run on both Haiku 5.5 and Haiku 4.5 and publish the comparison.
- **P-11 Phase 1 dependencies.** Drizzle (over Kysely), Better Auth, Socket.IO through `@nestjs/websockets`, Tailwind with custom tokens plus Radix primitives, Playwright.
- **P-12 Demo tenants.** A phone and accessories shop in Karama, Dubai (English, Arabic, Hindi and Hinglish, Malayalam) and a bakery in Kochi taking cake orders (Malayalam, English, Hindi).
