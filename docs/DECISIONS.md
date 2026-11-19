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

## Phase 1: tenancy and auth (2026-11-17)

### D-018 Drizzle ORM for queries, hand-written SQL for security

- **Chosen:** Drizzle for the schema and typed queries; `drizzle-kit generate` writes table migrations as SQL. Row-level security, grants and functions live in hand-written migration files.
- **Rejected:** Kysely. It is the more SQL-first of the two, but Drizzle gives schema-as-code with generated migrations and has a maintained Better Auth adapter.
- **Why hand-written security SQL:** policies and grants are the part a reviewer must read line by line, so they stay plain SQL rather than a DSL.

### D-019 Three database roles; tenant isolation fails closed

- **Chosen:**
  - `app_migrator` owns the schema (BYPASSRLS, runs migrations and seeds).
  - `app_user` is used by the API and worker. It cannot bypass RLS and owns nothing.
  - `app_platform` can only execute platform-admin functions.
  - Every tenant table has `ENABLE` and `FORCE ROW LEVEL SECURITY` with a policy on `app_current_tenant()`, which is `NULL` when no tenant is set, so reads return nothing and writes fail.
- **Rejected:** filtering by `tenant_id` in application code only, and a single `BYPASSRLS` admin role.
- **Why:** a forgotten `WHERE` clause cannot leak data, and the admin path is two narrow functions rather than a role that sees everything. This implements P-08.

### D-020 Tenant context is set per transaction

- **Chosen:** `withTenant()` runs `set_config('app.tenant_id', $1, true)` inside a transaction. Handlers reach tenant data only through `TenantDb.run()`.
- **Rejected:** session-level `SET` on the connection.
- **Why:** with a pool, a session-level setting can leak to the next request. A test proves the transaction-local setting is gone on the same pooled connection after commit.

### D-021 One business per person in v1

- **Chosen:** `memberships.user_id` is unique, so a session maps to exactly one tenant.
- **Rejected:** a tenant switcher.
- **Why:** shop and clinic staff work for one business. It removes an "active tenant" setting from the session and from the threat model.

### D-022 Better Auth for sign-in

- **Chosen:**
  - Better Auth 1.7 with the Drizzle adapter: sessions in Postgres, httpOnly `SameSite=Lax` cookies, Secure in production.
  - scrypt hashing (its default), passwords 12–128 characters.
  - No public sign-up (P-03).
  - Its handler is mounted in Express before the JSON body parser, as its docs require.
- **Rejected:** Lucia (no longer maintained), Auth.js (built around OAuth and JWTs; deliberately limits password sign-in), a hand-rolled session store, and Argon2id (a native dependency; scrypt is an accepted current algorithm).
- **Telemetry:** off explicitly, although it defaults to off.

### D-023 CSRF: Origin check plus SameSite=Lax

- **Chosen:** every POST, PUT, PATCH or DELETE must carry an `Origin` header equal to `PUBLIC_APP_URL`. Session cookies are `SameSite=Lax` as a second layer.
- **Rejected:** synchronizer tokens.
- **Why:** browsers always send `Origin` on these requests, the check is one line in one guard, and there is no token state to manage.

### D-024 Sign-in rate limit, keyed on a header the proxy controls

- **Chosen:** Better Auth's limiter: 5 sign-in attempts per minute per client IP, 100 requests per minute overall. The IP comes from `x-real-ip`. Memory storage is enough for one instance.
- **Production requirement (phase 9):** Next.js's `/api` proxy passes client headers through unchanged (verified), so in production Caddy must route `/api` straight to the API and overwrite `X-Real-IP` with the remote address. Otherwise a client could choose its own bucket.
- **Without an IP,** Better Auth falls back to one shared bucket per route: stricter, not open.
- **Revisit:** move to Redis storage when a second instance arrives.

### D-025 Routes fail closed

- **Chosen:** one `AccessGuard` checks, in order, the Origin, the session, the membership (through `auth_membership()`) and the route's level (`public`, `signed-in`, `member`, `owner`, `platform-admin`). A route with no annotation is `member`.
- **Why:** forgetting a decorator denies access instead of granting it.

### D-026 Audit log is append-only and transactional

- **Chosen:** `app_user` has only `SELECT` and `INSERT` on `audit_log`. Entries are written in the same transaction as the change and carry the request ID.
- **Why:** a change and its record commit together or not at all, and the application cannot rewrite history.

### D-027 Integration tests own their database

- **Chosen:** each run drops and recreates `app_test`, creates the roles and applies migrations, using URLs derived from the dev ones. Suites create their own tenants with random slugs, so files can run in parallel.
- **Why:** no test depends on leftover state, and no separate set of test URLs needs maintaining.

### D-028 Demo data is defined once

- **Chosen:** the demo businesses and staff live in `@app/shared`. The seed hashes passwords with Better Auth's own `hashPassword`, and the sign-in page lists the accounts in mock mode only.
- **Why:** the seed and the page cannot disagree, and seeded users sign in through the normal path.

### D-029 Self-hosted fonts, one file per script

- **Chosen:** woff2 subsets from Google Fonts with OFL licences, stored in `apps/web/public/fonts` (786 KiB in total). `unicode-range` means a browser downloads only the scripts present on the page.
- **Why:** mock mode must work offline and make no outbound calls.
- **Deferred:** Anek Devanagari and Anek Malayalam, until display text in those scripts exists.

### D-030 Tailwind with its defaults removed

- **Chosen:** Tailwind 4 with `--color-*: initial` and `--font-*: initial`, so only the DESIGN.md tokens exist and an off-palette colour cannot be written.
- **Lesson:** token names must not repeat across groups. A font size called `stamp` collided with the colour `stamp`: `text-stamp` rendered the top bar red and small. Screenshot review caught it, and the size is now `pane`.

### D-031 End-to-end tests run the production server

- **Chosen:** Playwright starts the built API and the same Next.js standalone server the Docker image runs (fonts and static files copied in). It runs at 1440 and 390 px and saves screenshots on every run. Each test uses its own `x-real-ip`.
- **Why:** this caught that standalone output omits `public/`. The web image would have shipped without its fonts; the Dockerfile now copies it.

### D-032 `NODE_ENV` is not set in `.env`

- **Why:** the Makefile exports `.env` to every command, and `next build` with `NODE_ENV=development` fails when prerendering. Each tool sets it itself; the app config defaults to development.

## Phase 2: simulator and WhatsApp pipeline in mock mode (2026-11-19)

Meta facts were checked against Meta's documentation on 2026-11-17: webhook and status payloads, signatures, error codes, business-scoped user IDs, media, and voice messages.

### D-033 Direct to Meta's Cloud API; protocol and domain in two packages

- **Chosen:**
  - The product calls Meta's Cloud API directly, with the Graph version set by `WHATSAPP_GRAPH_VERSION` (default `v26.0`).
  - `@app/whatsapp` holds the protocol: payload schemas, signature check, the Graph client and error classes.
  - `@app/pipeline` holds the domain: inbound processing, outbox, statuses, conversation state, queues and workers.
  - The API and worker are thin shells around them, and tests run the same wiring.
- **Rejected:**
  - Resellers (Twilio, 360dialog, Gupshup): per-message markup, another vendor, and payloads that differ from Meta's.
  - Unofficial WhatsApp Web libraries: they break WhatsApp's terms.

### D-034 One deployment, two providers (P-01 built)

- **Chosen:**
  - A channel row records its provider (`meta` or `simulator`).
  - Webhooks arrive on `/api/webhooks/whatsapp/:provider`, each checked with that provider's own app secret.
  - In mock mode `ProviderRegistry` never configures Meta, so no environment value can make a mock process call Meta.
- **Why:** the real number and the public simulator demo can share one server, and the product code is identical for both.

### D-035 Customers are identified by business-scoped user ID first

- **Chosen:** `customers` has a nullable `bsuid` and a nullable `wa_id`, with a check that at least one is present.
  - Lookup is by BSUID first, then phone.
  - Whichever identifier is learnt later gets filled in.
  - Replies go to `recipient: <BSUID>` when one is known.
- **Why:** since 2026 Meta omits the phone number for users with a username.

### D-036 Store first, process later

- **Chosen:**
  - The webhook endpoint checks the HMAC over the raw bytes (the route has its own raw body parser), inserts the body into `webhook_events`, enqueues the event's ID and returns 200.
  - A unique constraint on (channel, wamid) makes duplicates no-ops.
  - A sweeper re-enqueues events whose job was lost between insert and enqueue.
- **Why:** Meta retries for days, and duplicates are certain. A processing bug must not lose events, and the 200 must not depend on processing.

### D-037 Statuses only move forward

- **Chosen:**
  - Every status webhook is kept in `message_status_events`, deduplicated per status.
  - The message's status is a fold over those events: `sent` < `failed` < `delivered` < `read` < `played`.
- **Why:**
  - Any arrival order gives the same result.
  - A status that arrives before our send call returns is applied when it does.

### D-038 Reply ordering without BullMQ Pro (P-02 built)

- **Chosen:**
  - Every reply is a row in a transactional outbox, numbered per conversation.
  - One BullMQ job per message, with the message ID as the job ID.
  - The worker takes a per-conversation advisory lock. It sends only when every earlier reply has been sent, and the previous one is `delivered` or has waited `ORDER_HOLD_MS` (default 10 s).
  - A waiting job is moved to delayed without using up an attempt.
- **Rejected:**
  - BullMQ Pro groups: paid.
  - A queue per conversation: unbounded queues.
  - Waiting forever for `delivered`: one offline phone would block its conversation.
- **Why:** Meta says delivery order is not guaranteed and advises waiting for `delivered`.

### D-039 Retry what can succeed; dead-letter the rest

- **Retried with exponential backoff:**
  - Meta's rate-limit and transient codes: 1, 2, 4, 80007, 130429, 131000, 131016 and 131056.
  - 5xx responses and network errors.
- **Failed at once:** 131047 (window closed), 100, 131009 and 131026.
- **Dead letters** live in a Postgres table, written on a permanent error or once retries run out, and only platform admins can read them.
- **Rejected:** BullMQ's failed set as the dead-letter queue. It isn't queryable alongside tenant names, and it disappears with Redis.

### D-040 The 24-hour window is checked twice

- **Chosen:** free text is refused when queued (409, `window_closed`) and checked again at send time, without calling the API.
- **Window tracking:** `last_inbound_at` only moves forward, so a late, older message cannot reopen or shift the window.

### D-041 The assistant never sends while a person holds the conversation

- **Chosen:**
  - Ownership changes go only through `transitionConversation()`. It locks the row, checks the move is allowed, sets the holder, and logs the transition with actor and reason.
  - API-initiated changes also write an audit-log entry.
  - At send time, an assistant reply in a conversation that is no longer `assistant` is cancelled.
  - Staff can reply only while they hold the conversation.

### D-042 A send that times out may arrive twice

- **Accepted risk:** I found no idempotency key in the Cloud API send endpoint. A request that reaches Meta but whose answer is lost is retried, and the customer may see it twice.
- **Mitigation:** a 10-second client timeout, and the send is logged as ambiguous. Revisit if Meta adds idempotency keys.

### D-043 Simulator written independently of the parser

- **Chosen:**
  - The simulator builds Meta's payloads with its own code, not the product's schemas.
  - A test compares its payloads key-for-key with Meta's documented examples, and the product's parser is tested against the same examples.
  - Express 5 (already in the dependency tree via NestJS).
  - The page is deliberately not styled like WhatsApp.
- **Why:** shared code would let the two agree with each other while both disagree with Meta.
- **Exception:** the media upload route parses multipart with `Request.formData()`, which Node marks as not recommended on servers. It is acceptable for small test uploads, and avoids a parser dependency. The exception is commented in the code.

### D-044 Inbound media is copied at once

- **Chosen:** a media job exchanges the media ID for a URL and stores the file under `tenants/{tenantId}/media/{messageId}`. In mock mode that is local disk; in live mode it will be S3 (phase 7).
- **Why:** Meta's URLs expire after 5 minutes.
- **Safety:** keys are validated against a strict pattern, so path traversal is impossible.

### D-045 Logs mask personal data

- **Chosen:** pino `redact` masks text, body, caption, phone, `waId`/`wa_id`, `bsuid`, `from`, `to`, `recipient` and credentials, at the top level and one level down.
- **Verified:** a full containerised run logged zero occurrences of the message text, order number or phone number.

### D-046 Pipeline integration tests run one file at a time

- **Chosen:** each test file gets its own BullMQ prefix, and the pipeline's integration files run serially.
- **Why:** the sweeper correctly sees every tenant's stuck replies, as in production's single worker fleet. Parallel files acted as several fleets on one database and picked up each other's messages. That was a test artefact, not a product bug.

### D-047 Docker builds use `pnpm fetch`

- **Chosen:** fetch from the lockfile alone, which is cached until the lockfile changes; then copy the source and install offline.
- **Rejected:** listing each workspace package in the Dockerfile. It broke as soon as two packages were added.

### D-048 Non-null assertions are allowed in tests only

- **Why:** a wrong `!` in a test fails loudly on the next line, while narrowing every lookup would bury the assertions that matter. Production code keeps the rule.

### Known gaps after phase 2

- **No general API rate limit yet.** Sign-in is limited (D-024). A per-user limit for staff routes arrives with the inbox endpoints in phase 3. Webhooks are deliberately not limited, because Meta sends bursts.
- **A forged job naming the wrong tenant leaves its message queued.** The job is a no-op under RLS, but its job ID is then taken until the completed job is pruned. Only a bug or an attacker with queue access can do this.
- **Templates:** only the reopen template, named per channel. The language is fixed to `en` until tenant settings (phase 6).

## Proposed, awaiting approval

These came out of the first review of the brief. Approved on 2026-11-17 and built in phase 1: P-03 (no email; invites and reset links move to phase 6 with settings), P-08, P-11 (Radix arrives with the first menu or dialog) and P-12. P-01 and P-02 were approved and built in phase 2 (D-034, D-038). The rest are still open.

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
