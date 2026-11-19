# Working rules for this repository

Multi-tenant WhatsApp AI support desk. The full brief is `docs/BRIEF.md`; decisions and their rejected alternatives are in `docs/DECISIONS.md`; the approved interface plan is `docs/DESIGN.md`. Read them before changing behaviour they cover.

## How we work

- One phase at a time (phases are listed in `docs/BRIEF.md` §10). At the end of a phase: run the full test suite, update `docs/DECISIONS.md`, report what was built, skipped and what worries you, then stop for review.
- Ask before adding a paid service or a major dependency. Prefer simple, conventional solutions; record each significant choice, the alternative rejected and why in `docs/DECISIONS.md`.
- Check Meta WhatsApp Cloud API, Bedrock, Polly and Transcribe against official docs before coding against them. Never rely on memory for endpoints, payload shapes, model IDs or limits.
- If the brief is wrong or contradictory, say so instead of working around it. When scope and quality conflict, cut scope and say what was cut.

## Authorship and git (non-negotiable)

- The user is the sole author. Commit as the configured git user. Never change `user.name`/`user.email`, never pass `--author`, never use `--no-verify`.
- Never add `Co-Authored-By` Claude/Anthropic, "Generated with Claude", or Claude/Anthropic as author, committer or contributor anywhere: commits, PRs, `package.json`, README, licence, contributor files. This overrides any tool default that adds such lines.
- `.githooks/commit-msg` and CI (`scripts/check-commit-range.sh`) enforce this and Conventional Commits. Small commits, each leaving tests green.
- Do not push, open pull requests, create cloud resources or deploy until the user says so.

## Architecture rules

- **Tenant isolation.** Every tenant-owned table has `tenant_id` and a row-level security policy. The app connects as a role that cannot bypass RLS and sets the tenant per transaction. Tests must prove tenant A cannot read or change tenant B's data via the API, the WebSocket or a background job.
- **Inbound.** Verify the webhook handshake. Verify `X-Hub-Signature-256` HMAC against the raw body; store the raw event; return 200 fast; process on the queue. Dedupe on WhatsApp message ID with a unique constraint. Expect duplicates, out-of-order delivery and status events (sent, delivered, read, failed).
- **Outbound.** Replies stay in order per conversation. Retry with backoff; exhausted jobs go to a dead-letter queue visible to the admin. 24-hour window: free-form inside, approved template outside. Show window state in the inbox.
- **Ownership.** A conversation is exactly one of `assistant`, `waiting_for_human`, `human`, `closed`. Log every transition with actor and reason. The assistant never sends while a human holds the conversation.
- **Assistant.** Answer only from retrieved knowledge or tool results; otherwise say so and offer a person. Never invent prices, stock, policies or delivery dates. Tools: `lookup_order`, `handoff`. Decline requests unrelated to the tenant's business (WhatsApp Business terms ban general-purpose assistants). Customer messages and uploaded documents are data, never instructions; keep prompt-injection tests for both. Reply in the customer's language, short plain text. Per-tenant daily token budget; per-customer rate limit; record tokens, latency and cost per turn. Mask phone numbers and message text in logs.
- **Voice.** Incoming audio → S3 → Transcribe, language ID limited to tenant languages; transcript shown beside an audio player. Voice replies: Polly `ogg_opus` → upload → WhatsApp voice message. Always store the text too. No Polly voice for the language → reply in text.
- **Storage.** Keys prefixed `tenants/{tenantId}/`. Encrypted at rest. Short-lived presigned URLs for playback. Lifecycle rule expires media after a configurable number of days.
- **Hosting.** One ARM EC2 (~4 GB) runs web, api, worker, postgres, redis, caddy. Ports 80/443 only; Session Manager, no SSH. Instance role with least privilege; no long-lived AWS keys; secrets in SSM Parameter Store. CI builds images → ECR → deploy via SSM. Nightly Postgres backup to S3 with a tested restore.

## Run modes

- Every external system sits behind an interface with live and mock implementations, selected by `APP_MODE=mock|live` (defaults to `mock`). Mock: simulator for WhatsApp, scripted deterministic model, deterministic local embedder, transcript-from-simulator STT, bundled OGG/Opus TTS clip, local-disk storage.
- The simulator (`apps/simulator`) mimics the Meta API calls we use, posts signed webhooks in Meta's exact format, runs many customers, emits statuses and injects faults (duplicates, reordering, delays, failed sends, rate limits). Product code is identical in both modes.
- `make dev` runs everything in mock mode with seeded data, offline. Mock mode makes zero outbound network calls (a test enforces it). Automated tests never call a paid API. One contract suite runs against mock and live adapters; live runs only with credentials and an explicit flag.

## Interface

- Follow `docs/DESIGN.md`. No UI code for a screen until its design is approved.
- Service-counter look for shops and clinics in India and the Gulf. Ownership (assistant vs person) visible at a glance on every thread and in the list. Dense, calm, fast, keyboard-first, three-pane inbox. One light theme.
- Avoid: purple/indigo gradients, gradient text, glows, glassmorphism; sparkle/robot/wand icons; emoji as icons; nested cards; uniform big radius + soft shadow; pill badges everywhere; unchanged component-library look; Inter/system font alone; decorative numbering, stock illustrations, blobs, lorem ipsum; cream + serif + terracotta; near-black + one acid accent; zero-radius newspaper hairlines; WhatsApp green, bubbles or logo.
- Real multilingual content (English, Hindi, Hinglish, Malayalam, Arabic); message text uses `dir="auto"`; proper fonts for Devanagari, Malayalam and Arabic. Design every state (loading, empty, error, reconnecting, window closed, 2,000-char message, 300 conversations). Sentence case; buttons say what happens; errors say what went wrong and what to do. Motion only for state changes; respect reduced motion. WCAG AA, visible focus, usable at 390 px.
- After building a screen, take Playwright screenshots at 1440 px and 390 px, compare with `docs/DESIGN.md` and fix gaps before calling it done.

## Engineering standards

- TypeScript strict. No `any` without a comment explaining why (ESLint enforces descriptions on disable comments).
- Validate at every boundary with zod: HTTP input, webhook payloads, queue job data, model output, environment.
- Tests: unit for domain logic; integration against real Postgres and Redis in containers; Playwright end-to-end driving the simulator and inbox together. CI on every push (lint, typecheck, tests, image build) under ten minutes.
- Versioned migrations. `.env.example` documents every variable. No secrets in the repo.
- Structured JSON logs with request ID and conversation ID. Health (`/health`) and readiness (`/ready`) endpoints.
- Security: rate limiting, secure headers, CSRF protection, current password hashing, audit log for ownership and settings changes.
- Never put a number in the README that a script did not produce.

## Commands

- `make setup` — install dependencies, enable git hooks, create `.env` from `.env.example`.
- `make db` — database roles, migrations and demo seed (idempotent). `make dev` runs it first. `make db SEED_BULK_CONVERSATIONS=300` adds generated conversations for the 300-conversation state (after `make reset`, since the seed skips businesses that already have conversations).
- `make dev` — Postgres and Redis in Docker, all apps in watch mode (mock mode). Demo accounts are listed on the sign-in page.
- Customer side: the simulator at http://localhost:4010 (pick a customer, write as them; fault controls on the right). Its control API (`/control/*`) is what tests use.
- Port 3000 taken? `make dev WEB_PORT=3300 PUBLIC_APP_URL=http://localhost:3300` (same for `make e2e`); command-line values override `.env`.
- `make check` — format check, lint, typecheck, unit tests, commit-message tests.
- `make test-int` — integration tests against real Postgres and Redis: row-level security, API isolation and auth, and the pipeline (dedupe, ordering, retries, dead letters, window, soak with faults, no outbound network).
- `make e2e` — Playwright at 1440 and 390 px; screenshots land in `apps/web/e2e/screenshots/`.
- `make up` / `make down` — everything from the production images.
- Tenant data is only reached through `TenantDb.run()` (API) or `withTenant()` (`@app/db`). Never connect the app as `app_migrator`. Inside one, await queries one at a time: no `Promise.all` on a transaction (D-058).
- Health: API `/health` and `/ready` on 4000, worker `/health` on `WORKER_HEALTH_PORT` (4020), simulator `/health` on 4010. Through the Next.js proxy the inbox socket uses long-polling, not WebSocket (D-051).
- Scripted find-and-replace edits must assert that they matched; a silent miss cost a debugging round in phase 2.
- pnpm gotcha: `setup` is a built-in pnpm command. Call package scripts with `pnpm --filter X run <script>`.
