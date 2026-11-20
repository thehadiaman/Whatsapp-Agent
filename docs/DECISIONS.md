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

## Phase 3: inbox with live updates, take over and hand back (2026-11-19)

### D-049 Live updates carry IDs, not content

- **Chosen:**
  - The worker and the API publish `{tenantId, conversationId}` on one Redis pub/sub channel after each commit.
  - A Socket.IO gateway forwards the conversation ID to that business's room. The inbox then refetches the list and the open conversation through the HTTP API.
  - The socket is receive-only: clients cannot emit anything the server acts on.
- **Rejected:**
  - Pushing full conversation payloads. Every emit would need its own authorisation and shaping, outside row-level security.
  - Postgres `LISTEN/NOTIFY`. It holds a connection per API process and loses notifications while that connection is down; Redis is already there for BullMQ.
- **Why:** row-level security stays the only gate on content. A bug in room membership could leak at most an ID, never message text.
- **After a reconnect:** everything is refetched, because events sent while offline are gone. The top bar and a banner say "Reconnecting…" and when updates paused.

### D-050 The socket handshake accepts a missing Origin only from the same site

- **Chosen:**
  - If `Origin` is present, it must equal the web app's origin.
  - If it is absent, `Sec-Fetch-Site` must be absent or `same-origin`.
  - Then the session cookie and a business membership are required, as for HTTP.
- **Why:**
  - Browsers send no `Origin` on same-origin GET requests, and Socket.IO's polling handshake is a GET. The first, strict version refused every real browser; the integration test had missed it because its Node client always sent `Origin`.
  - A cross-site browser request always carries `Origin` or `Sec-Fetch-Site: cross-site`, so cross-site WebSocket hijacking is still refused. Non-browser clients can forge either header; the session check is what stops them.
- **Tests:** a same-origin polling handshake without `Origin` connects; a cross-site one without `Origin` is refused; a wrong `Origin` is refused.

### D-051 The socket path has no trailing slash

- **Chosen:** `addTrailingSlash: false` on the gateway and the client, so the path is `/api/socket.io?EIO=…`.
- **Why:** Next.js rewrites strip the trailing slash, and its default 308 redirect sent the browser to a path the API did not serve. `skipTrailingSlashRedirect` stops the redirect.
- **Known limit:** the Next.js rewrite does not carry the WebSocket upgrade, so in development and in the end-to-end tests Socket.IO stays on long-polling. Live updates still arrive. In production Caddy routes `/api` straight to the API; phase 9 must check that the upgrade works there.

### D-052 Per-person rate limits in Redis

- **Chosen:**
  - A fixed-window counter in Redis per user and route group: 600 requests a minute overall, 60 replies, 30 notes.
  - It is checked in the access guard after the session is known, and answers 429 with `Retry-After`.
- **Rejected:** `@nestjs/throttler`. Its default store is per process, and a shared Redis store is a separate package, for what is one `INCR` and one `EXPIRE`.
- **Webhooks:** still not limited (D-036).

### D-053 Customer files are only shown inline when they cannot run code

- **Chosen:**
  - Only JPEG, PNG, WebP and audio are served inline.
  - Everything else is served as `application/octet-stream` with `Content-Disposition: attachment`, and with `nosniff`.
- **Why:** HTML, SVG or PDF sent by a customer and served from our origin could run script inside a signed-in staff session.

### D-054 Conversations are numbered per business

- **Chosen:**
  - A counter on the tenant row, taken under a row lock when a conversation opens.
  - Staff say "conversation 214", and the token in the list matches DESIGN.md.
  - Existing conversations were numbered in the migration.
- **Rejected:**
  - A Postgres sequence per tenant: sequences sit outside row-level security, and creating one per tenant is DDL at runtime.
  - `max(number) + 1`: two first messages at the same moment could get the same number.
- **Cost:** new conversations for one business open one at a time. Each takes milliseconds.

### D-055 One component owns the inbox state; no data-fetching library

- **Chosen:**
  - One client component holds the list, the open conversation and the connection state. It refetches when the socket names a conversation.
  - Responses for a conversation that is no longer open are dropped.
- **Rejected:** TanStack Query. The inbox has one list and one detail, and the socket decides when to refetch, so caching and invalidation rules would add a dependency without removing code.
- **React Compiler rules:** refs are not read during render, and state is not set inside effects. Selecting a conversation is an event handler, and the initial selection comes from the URL on the server.

### D-056 No list virtualisation

- **Chosen:** queue rows use `content-visibility: auto` with an intrinsic size. The browser skips layout and paint for rows out of view.
- **Rejected:** a virtualisation library. It breaks find-in-page and sticky group headings, and makes keyboard focus moves harder.
- **Checked:** 300 open conversations (the DESIGN.md state) at 1440 and 390 px. Above roughly 2,000 open conversations a business would need paging. That is beyond the shops this is for.

### D-057 Seed data is a small story, not random rows

- **Chosen:**
  - A script per demo business, with times relative to now. That gives a conversation held by a person with a note, one waiting with a 2,019-character message, one past the 24-hour window, Arabic, Malayalam and Hinglish.
  - `SEED_BULK_CONVERSATIONS` adds generated conversations for the 300-conversation state. CI's end-to-end job uses 300.
  - Seeding is idempotent.
- **Why:** every state in DESIGN.md can be opened and screenshotted without clicking through a script first.

### D-058 One transaction runs one query at a time

- **Chosen:** queries inside `TenantDb.run()` or `withTenant()` are awaited one after another, never with `Promise.all`.
- **Why:** a transaction is one connection, and pg runs one query at a time on it, so parallel queries gain nothing. pg 8 warns and pg 9 rejects them. The conversation detail query did this until the warning was traced in phase 3.

### Known gaps after phase 3

- **A revoked session keeps its socket until it reconnects.** It receives only conversation IDs; every refetch goes through the API, which refuses the revoked session. Disconnecting sockets on sign-out or removal belongs with staff management in phase 6.
- **"Explain this reply"** shows its empty state until the assistant exists (phase 4).
- **No presence or typing indicators.** Two people pressing Take over at once is safe: the first wins, and the second gets a 409 with the reason.
- **The WebSocket upgrade through Caddy is unverified** until Caddy exists (phase 9, D-051).

## Phase 4: knowledge base, assistant and Bedrock (2026-11-20)

### D-059 Claude in Amazon Bedrock through the Messages API, behind a model port

- **Chosen:**
  - A model port whose shape mirrors the Claude Messages API (text, tool_use and tool_result blocks). The scripted mock implements it now; the live adapter (phase 7) is `AnthropicBedrockMantle` from `@anthropic-ai/bedrock-sdk`, a thin mapping.
  - Model IDs `anthropic.claude-haiku-5-5` and `anthropic.claude-haiku-4-5`. In Mumbai (`ap-south-1`) Claude in Amazon Bedrock has the global endpoint only, at no premium; regional endpoints cost 10% more. The IAM action is `bedrock-mantle:CreateInference`.
  - Every model response is parsed with zod before use. A malformed one hands the conversation to a person at once, without retrying.
- **Rejected:** the Converse and InvokeModel APIs on `bedrock-runtime`. Anthropic's Bedrock guide points new code at the Messages API endpoint, and Converse would need its own request and response mapping.
- **Checked on 2026-11-20** against Anthropic's "Claude in Amazon Bedrock" page.
- **Open for phases 7 and 8:**
  - Current Anthropic SDKs send API version `2026-10-21`, which Bedrock accepts only for Claude 4.7 and later. The Haiku 4.5 comparison in the evals may need a pinned older SDK.
  - Bedrock's price for Haiku 5.5 could not be confirmed. Turns are costed from a price table that starts with Anthropic's list prices, and an unknown model refuses to be costed rather than recording zero.

### D-060 Embeddings: 1,024 dimensions now, the live model chosen by an eval

- **Chosen:**
  - `vector(1024)`, the default size of Amazon Titan Text Embeddings V2 and of Cohere Embed Multilingual v3, so either fits without a migration.
  - Each passage records the model that embedded it.
  - Each embedder declares its own relevance floor, because similarity scales differ between models.
- **Candidates for phase 7** (AWS model pages, read 2026-11-20):
  - Titan V2 (`amazon.titan-embed-text-v2:0`, 8,192 tokens) lists Malayalam, Arabic and Hindi, but AWS warns that cross-language queries give sub-optimal results.
  - Cohere Embed Multilingual v3 is built for cross-lingual search but reads only 512 tokens.
  - Cohere Embed v4 (`global.cohere.embed-v4:0`, 128K tokens) reaches Mumbai through global routing.
  - Both Cohere models are billed through AWS Marketplace.
- **Why the eval decides:** a shop's catalogue is usually in English while customers ask in Malayalam, Arabic or Hinglish. That cross-lingual case is the one to measure before choosing.
- **Mock:** the hashing trick over words and character trigrams. It is deterministic and offline, and knows no synonyms and no other language.

### D-061 Hybrid retrieval

- **Chosen:**
  - The 20 nearest passages by embedding, plus the 20 best Postgres full-text matches (the `simple` configuration, words joined with OR, a small stop list).
  - These are fused by reciprocal rank (k = 60). The top five are read most similar first, so their order and the scores shown with them agree.
- **Rejected:**
  - Vectors alone: they miss exact product names, model numbers and order numbers.
  - The `english` text-search configuration: it stems English only, while `simple` treats every script alike.

### D-062 Exact nearest-neighbour search, no ANN index

- **Chosen:** no HNSW index. A business has hundreds to a few thousand passages, which Postgres scans exactly in milliseconds.
- **Why:** an approximate index searches before row-level security filters out other businesses' rows, so a small tenant could get too few results. Exact search is simple and always correct.
- **Revisit:** above about 50,000 passages for one business, with pgvector 0.8's iterative index scans.

### D-063 Prompt injection is contained in code, not only in the prompt

- **Chosen:**
  - **Prompt structure:** the system prompt holds only the rules and the business profile. Customer messages and passages go in tagged data blocks, with `<`, `>` and `&` escaped, so a document cannot close its own block.
  - **Tool authorisation:** `lookup_order` returns an order only to the customer who placed it. Anyone else's order looks exactly like no order.
  - **Figure guard:** every number in a reply must appear in the passages, the tool results or the conversation, in any digit script. Otherwise the reply is not sent and a person takes over. False positives fail safe.
- **Tests:**
  - A scripted "obedient" model that follows planted instructions shows these guards hold whatever the model does.
  - The escaping is unit-tested against a planted closing tag.
- **Limit:** numbers written as words are not caught, and how well the real model resists injection is measured by the evals (phase 8).

### D-064 One answer per burst, never two

- **Chosen:**
  - Every customer message queues a turn, delayed `ASSISTANT_DEBOUNCE_MS` (1.5 s) and keyed by the message ID.
  - A turn answers only if its message is the newest one not yet answered, so a burst of messages gets one reply.
  - `assistant_turns.trigger_message_id` is unique, so a retry cannot answer twice.
  - Duplicate webhook deliveries re-queue the turn. That is what recovers from a crash between commit and enqueue.
  - The sweeper also re-queues unanswered messages from the last hour.
- **Tests:** a burst, a duplicated delivery, and a deleted job recovered by the sweep.

### D-065 Limits hand over; they never go silent

- **Chosen:**
  - **Daily budget:** a token budget per business per local day (default 300,000). When it is used up, the customer gets a notice and the conversation waits for a person.
  - **Rate limit:** 20 assistant turns per customer per hour. Beyond that the assistant stops replying with no message, which avoids feeding a loop or spam, and a person takes a look.
  - **Handoff notice:** in English, Hindi, Hinglish, Malayalam or Arabic, chosen by script without a model.
  - **Kill switch:** `ASSISTANT_ENABLED` stops new turns everywhere.
- **Known race:** two turns checking the budget at once can both proceed, overshooting by one turn's tokens.

### D-066 The handoff notice goes out while a person is awaited

- **Changed:** a queued assistant message is now cancelled only when a person holds the conversation or it is closed, not when it is merely waiting.
- **Why:** phase 2's send-time rule cancelled the "a person will reply here soon" notice the moment the handoff it announced took effect. The brief forbids sending while a person _holds_ the conversation, and waiting is not holding.

### D-067 Reading knowledge files

- **Chosen:**
  - **PDF:** `pdfjs-dist` (Mozilla's reference implementation), text only. A scanned PDF is refused with advice (no OCR, P-06).
  - **Word:** `mammoth`.
  - **CSV:** a small RFC 4180 parser instead of a third dependency. One passage per catalogue row, so a price is always retrieved with its product.
  - **Limits:** 10 MB, with the type decided by file extension.
  - **Passages:** up to 1,200 characters, split at sentence ends in Latin, Devanagari and Arabic scripts.
  - **Versions:** a new version replaces the passages in one transaction, and a failed source keeps none.
- **Leaner install:** pdfjs's optional native canvas binary (35 MB, used only to render pages) is excluded with `ignoredOptionalDependencies`. pdfjs prints a one-off notice about rendering the first time the worker reads a PDF.

### D-068 Live mode never answers with the mock

- **Chosen:** until the Bedrock adapters exist, live mode uses an unconfigured model that makes every turn hand over to a person.
- **Why:** answering a real customer with the scripted mock would be worse than no answer.

### D-069 Receipts are records

- **Chosen:**
  - `assistant_turns` is append-only for the app; only the reply link can be updated.
  - The receipt says what it is: mock token counts are labelled "estimated", the mock costs "$0 · mock model", and seeded sample replies say they have no receipt rather than showing invented numbers.

### D-070 One media directory for the API and the worker

- **Changed:** `make` resolves the storage path from the repository root, and Compose mounts one named volume in the API, worker and seed.
- **Why:** this was a bug from phase 2. In `make dev` each app ran from its own folder, so the relative `MEDIA_STORAGE_DIR` gave the worker and the API different directories. Under Compose each container had its own `/tmp`. Customer photos were stored where the API could not serve them; tests passed because they share one temporary folder.

### D-071 Typed linting gets a 4 GB heap

- **Why:** linting 135 files across nine TypeScript projects peaks at 2.6 GB, past Node's default heap here.

### Known gaps after phase 4

- **The mock is wiring, not quality.** Replying in the customer's language, declining off-topic requests and resisting injection are only as good as the real model. The evals (phase 8) measure them.
- **Cross-lingual retrieval** is the main quality risk (D-060).
- **Not built:** the "assistant is writing…" state from DESIGN.md.
- **Media and orders:** customer photos and documents reach the model only as "[Photo]" markers (P-07). Orders are seeded; importing them comes with settings (phase 6).
- **Unverified:** Bedrock prices and the Haiku 4.5 SDK version question (D-059).

## Phase 5: voice notes in and out (2026-11-20)

Mock mode only, as planned: the Transcribe and Polly adapters are phase 7. Everything here runs offline, and live mode uses "unconfigured" adapters that hand voice notes to a person and send replies as text.

### D-072 Which voice and which transcription language

- **Checked on 2026-11-20** against the AWS docs ("Available voices", "Bilingual voices", SynthesizeSpeech; Transcribe "Supported languages" and batch language identification).
- **Voices:** Kajal (neural) for English (`en-IN`) and Hindi (`hi-IN`); Hala (neural) for Gulf Arabic (`ar-AE`); none for Malayalam, so it goes as text. Kajal is fully bilingual and reads Hindi in Latin script too, so Hinglish replies use her with `hi-IN`.
- **Transcription:** one dialect per language: `en-IN`, `hi-IN`, `ml-IN`, `ar-AE`. Each is supported in batch, and only Swedish and Vietnamese are excluded from language identification.
- **Rejected:** Aditi (standard engine only) and Zeina (Modern Standard Arabic, standard engine), in favour of the neural voices and the Gulf dialect the Dubai shop's customers speak.
- **Format facts used:** `ogg_opus` is 48 kHz only; WhatsApp voice messages are Ogg with Opus, mono, up to 16 MB, and play inline only up to 512 KB.

### D-073 A mock voice note carries its words inside the file

- **Chosen:** the simulator writes the customer's words and language into the Ogg Opus comment header (`TRANSCRIPT`, `LANGUAGE`). The product copies the file as usual, and the mock speech-to-text reads the words back from our stored copy. The mock voice for replies is a bundled 1.2 s clip (made with ffmpeg by `packages/voice/scripts/make-clip.sh`) carrying the reply's words the same way, so the simulator shows what a reply says.
- **Why:** product code is identical in both modes (brief §5). The file is the only thing that crosses from the simulator, as with a real recording.
- **Rejected:** a simulator endpoint the mock speech-to-text asks for the transcript, which would be a network call and a mock-only path; a sidecar file next to the media.
- **Own code, not a dependency:** about 250 lines to read and rewrite Ogg pages (checksums recomputed, audio pages copied). No maintained npm package rewrites Opus comments without native ffmpeg, and ffmpeg in the images would add tens of megabytes. Tested by round trip, a multi-page header, a corrupted file, and by ffmpeg decoding the output cleanly (checked by hand).

### D-074 The assistant waits for the transcript; a failed one goes to a person

- **Flow:** webhook → copy the file → transcription job (its own queue, 4 attempts) → transcript stored → assistant job for the conversation's newest customer message.
- **Waiting:** a turn that finds a pending transcript among the unanswered messages stands aside. When the transcript lands it queues a fresh job (`{messageId}-after-{noteId}`, since a finished job's ID stays taken), and the turn's unique trigger still allows one answer. Text sent while a note was being transcribed is answered once, together with the note (tested with a speech-to-text the test holds open).
- **Failure:** a note that cannot be transcribed (unreadable, no speech, a language the business does not list, download failed for good) hands the conversation to a person without calling the model. The assistant never guesses what was said, and it does not answer only the typed part of a turn.
- **Lost jobs:** a sweep (`pending_transcripts`) redoes the copy or the transcription for notes pending more than 30 s and less than an hour.
- **Rejected:** transcribing inside the copy job, which would mix two failure modes and two retry policies (a Transcribe job takes seconds to minutes).

### D-075 When the assistant speaks

- **Rule:** the business has voice replies on, and the customer's latest message was a transcribed voice note.
- **Rejected:** speaking every reply when the setting is on (customers who type would get voice notes); remembering a per-conversation preference (more state for little gain).

### D-076 Speech is made at send time, and falls back to text with a reason

- **When:** the reply row keeps its text and a `speech` record. Language and length are decided when the reply is queued: no voice for the language, or over 1,000 characters, means text from the start, so the inbox says why at once. The audio is made by the send job, stored under `tenants/{id}/media/{messageId}`, uploaded to WhatsApp and sent with `voice: true`. A retry reuses the stored audio or the uploaded media ID.
- **Fallbacks, shown as "Sent as text: …":** no voice (Malayalam), too long, over WhatsApp's 512 KB inline-play limit, or synthesis failed.
- **Synthesis failure falls back at once** instead of retrying: the customer is waiting for an answer. Trade-off: a Polly throttle that would clear in a second still costs the voice. Revisit with real error rates in phase 8.
- **Window:** a voice note is free-form, so the 24-hour window applies to it as to text.

### D-077 Staff can send a voice reply

- **Chosen:** "Voice reply: on/off" in the composer when the business has voice replies on; the reply is spoken in the language it is written in (script detection). With the setting off the API refuses with 400 and says how to turn it on.
- **Why:** DESIGN.md shows the switch, and the same send path serves both.

### D-078 A voice-note player in the counter's style, with the length up front

- **Chosen:** a play button, the time in mono and a ruled progress line. The length is read from the Ogg file when the note is copied or made.
- **Rejected:** the browser's `<audio controls>`: it looks different in every browser, against DESIGN.md's "no unchanged component-library look", and shows 0:00 until the file loads.
- **Fallback:** a browser that cannot play Ogg Opus shows "This browser can't play it" with a download link.

### D-079 The thread opens at the latest message

- **Changed:** opening a conversation scrolls to the newest line, and new lines follow unless the reader has scrolled up. Phase 3 opened every thread at the top, which voice notes made obvious at 390 px.

### D-080 Tenant languages and voice replies are tenant settings

- **Chosen:** `tenants.languages` (a check limits it to `en`, `hi`, `ml`, `ar`) and `tenants.voice_replies` (default off). The seed sets them only when it creates a tenant, because afterwards they belong to the owner (the settings page is phase 6).
- **Consequence:** a database seeded before this phase keeps English only and voice replies off. `make reset` reseeds; I updated the two demo tenants in the local database by hand.

### Known gaps after phase 5

- **Live adapters:** Transcribe and Polly are phase 7. P-09 (detect the language once, then reuse it) is still open and lands there; the port already takes a list of languages, so it needs no new interface.
- **Short notes and language ID:** Transcribe recommends 30 s of speech for identification, and most voice notes are shorter. Expect misidentification between Hindi and Indian English. Phase 8 measures it.
- **Playback:** the API streams audio from storage. Presigned S3 URLs for playback come with the S3 adapter (phase 7), and the media expiry rule with Terraform (phase 9).
- **The simulator types, it does not record:** voice notes are the bundled clip plus typed words. No microphone capture.
- **Not checked:** Polly and Transcribe prices (phase 7, with the adapters).

## Phase 6: analytics and tenant settings (2026-11-20)

Approved on 2026-11-20 before building: the settings design (now in DESIGN.md), cutting order import, P-04 moving to phase 7, and P-05.

### D-081 Settings: one page, each section saved and audited on its own

- **Chosen:** the sections are business, opening hours, assistant (tone, daily budget, replies per customer per hour), escalation, languages and voice, WhatsApp templates and team. Each has its own save button, which sends one `PUT /api/settings/{section}` and writes one audit entry with that section before and after. "Changed 19 Nov 14:32 · Anil Kumar" comes from the audit log, so the stamp and the record cannot disagree. Agents read the page but cannot save; the team section is the owner's alone.
- **Rejected:** one Save button for the whole page, which turns an unrelated validation error into a lost edit and makes the audit entry one large diff. Tabs were rejected because the page is read top to bottom once and then visited one section at a time.
- **Validation:** the same shared zod schemas run in the browser before sending and in the API, so a bad time ("Monday: closing time must be after opening time") is caught before the request.

### D-082 Opening hours: one span a day, in the business's time zone

- **Model:** per weekday either `{open, close}` (`HH:MM`) or closed; `null` means hours not set, which counts as always open, so nothing is ever "after hours". No overnight spans in v1: a shop open past midnight sets 23:59. Recorded as a limit.
- **Used for:** the outside-hours line on handovers (D-083), the hours given to the model as a fact (D-085), and analytics' after-hours waits (D-084).
- **Next opening** is computed from the business's wall clock and turned back into an instant in two passes, so daylight saving changes land correctly (tested with Europe/London; the demo zones have none).

### D-083 Escalation rules run before the model, deterministically

- **Keywords:** if a customer message contains one of the owner's words or phrases, the conversation goes to a person and the model is not called. Matching is case-insensitive, NFKC-normalised and whole-word in any script, so "refund" matches "REFUND please" but not "refunded", and "पैसे वापस" matches inside a Hinglish sentence. Tested in English, Hindi, Arabic and Malayalam.
- **Reply limit:** after N assistant replies a person takes over. The count restarts when a person hands the conversation back.
- **Outside hours:** any handover while the business is closed adds a line in the customer's language: "We're closed now. A person from our team will reply when we open: Monday 10:00." The day and time are formatted with Intl for that language. The owner can turn this off.
- **Rejected:** putting the words in the prompt for the model to act on, which can't be guaranteed or tested, and costs a model call for a decision a string match can make.
- **Reason codes:** every handover records a code on its turn (`assistant_turns.handoff_reason`): the model's handoff reason, or `escalation_keyword`, `reply_limit`, `voice_untranscribed`, `guard_blocked`, `budget_exhausted`, `rate_limited` or `failed`.

### D-084 Analytics are computed on read, with stated definitions

- **Definitions:** days are the business's local days.
  - A conversation counts on the day it started.
  - Each conversation is exactly one of: "assistant only" (never went to a person), "waiting now", or "a person took part". The three add up to the total.
  - Reply time: from the customer's message to the assistant's reply being sent.
  - Cost per conversation: the model cost of its turns, divided by the number of conversations.
  - Handover reasons: the turn codes (D-083), plus "staff took over" for take-overs straight from the assistant.
  - Human reply time: from "waiting for a person" to the first staff message, split into waits that began while the business was open and while it was closed.
- **Caveat:** "resolved without a person" includes conversations still open with the assistant. It means "not handed over so far", not "the customer was satisfied". The page's sentence says "without a person" for that reason.
- **Computed on read:** five queries inside the tenant's transaction, with percentiles in TypeScript (`percentile_cont` interpolation, unit-tested). Its speed is not measured yet. **Rejected:** nightly rollup tables, a second source of truth before any measured need. The phase 8 load test will say whether one is needed.
- **Design:** as approved: a sentence, the custody chart in the inbox's three marks, a day book and the ranked reasons. No KPI tiles.

### D-085 Tone and hours reach the model as settings and facts

- **Tone:** warm, brief or formal, as one line of the system prompt. The owner sees a sample reply for each. The mock model ignores tone; the prompt test checks the line, and the real model's behaviour is for the evals (phase 8).
- **Hours:** given to the model as a fact it may quote ("Mon–Sat 10:00–22:00 · Sun closed"), escaped like any other data. They are also added to the figure guard's evidence, so "we open at 10:00" is not held back as an invented number.

### D-086 Staff accounts without email (P-03 built)

- **Invite:** the owner enters a name, an email (the sign-in name; nothing is sent to it) and a role, and gets a link to hand over. It works once and expires in 7 days. Opening it, the person chooses a name and a password (12+ characters, the same rule as sign-in). The account and membership are created in that business, and the invite is claimed first, so two tabs racing cannot create two accounts.
- **Password reset:** the owner makes a link valid for 1 hour. Using it sets the password and deletes that person's sessions, signing them out everywhere.
- **Tokens:** 256 random bits in the URL; only the SHA-256 is stored, so a database copy holds no working link. A signed-out page reads a link through one narrow `SECURITY DEFINER` function per kind (like `auth_membership`), and everything else happens inside the tenant under row-level security. Expired, used and made-up tokens all answer the same 410.
- **Removal:** deletes the membership and sessions, closes the person's live inbox sockets (a per-user Socket.IO room), and moves conversations they held to "waiting for a person" with the reason in the ledger. An owner cannot remove themselves.
- **Rate limits:** the public link routes are limited by client address. Behind the web proxy every request comes from one address, so in practice this is a ceiling for the whole route (20 tries a minute); brute force is already hopeless at 256 bits.
- **Rejected:** Better Auth's own reset flow, which is built around sending email (P-03 rules out email in v1); storing tokens in clear.

### D-087 Reopen templates per language (P-05 built)

- **Changed:** the template name moved from the channel to the business, as a map from language to name, kept from the old column by the migration. The inbox sends the template in the customer's language, judged from their latest message or its transcript, else English, else whichever exists. The message stores the template's language, and the send uses it instead of a fixed `en`.
- **Checked on 2026-11-20** in Meta's "Supported languages" table: `en`, `ar`, `hi` and `ml` are valid template language codes, so the business languages map directly.
- **Not checked:** whether a name the owner types is an approved template on Meta. That needs the live API (phase 7); a wrong name fails at send time with Meta's error, shown on the message line.

### D-088 Thirty days of seeded history, honest about cost

- **Chosen:** the seed adds about four weeks of closed conversations per demo business: questions in the demo languages, assistant turns, about one in five handed over for a mix of reasons, staff replies, and after-hours waits that end when the shop opens. It is generated from a fixed seed, and only once, recognised by its customers (`HIST.*`). Only closed conversations, so the inbox's open list is unchanged.
- **Cost:** every seeded turn is recorded as the mock model's, so cost reads $0, and the page says so ("Cost is $0: the mock model answered"). Seeding plausible Bedrock costs would put numbers on screen that no model produced.
- **Fixed during the phase:** the first idempotency check ("any conversation older than two days") skipped a database that already held older conversations. The script seed's own check now ignores history conversations.

### D-089 `g` then a letter switches sections

- `g i`, `g k`, `g a` and `g s` (DESIGN.md "Keyboard first"). The handler listens in the capture phase and swallows the second key, so `g a` never also opens the inbox's Assign menu.

### Known gaps after phase 6

- **Order import was cut** (decided on 2026-11-20). Orders exist only in the seed; the brief's "sample tenant API" for order lookup is not built. A business has no way yet to load its own orders.
- **P-04** (WhatsApp credentials in settings) moves to phase 7 with the Meta adapter.
- **Staff:** no changing an existing person's role (remove and invite again); one business per person, so an email already in use cannot be invited.
- **One API instance:** closing a removed person's sockets reaches only this instance's connections. Several API instances would need the Socket.IO Redis adapter.
- **Hours:** no overnight spans, no holidays.
- **The figure check and hours:** times in the hours fact count as evidence, so a model could quote an opening time correctly from the hours while the knowledge base says otherwise. The hours are the owner's latest word, so this is the intended source.

## Phase 7: live adapters (2026-11-20)

Approved on 2026-11-20 before building: Cohere Embed Multilingual v3 (a paid AWS Marketplace model), the AWS SDK v3 clients and `@anthropic-ai/bedrock-sdk`, offline verification now with the live run later, and AES-256-GCM for WhatsApp tokens (P-04). No cloud resource was created and no paid API was called: every live adapter is checked against the docs and with fake SDK clients, and the live contract suite waits for credentials (D-096).

New dependencies, in a new `@app/live` package that only the API and worker load: `@anthropic-ai/bedrock-sdk` 1.1.2 and `@aws-sdk/client-{bedrock-runtime,s3,transcribe,polly}` and `@aws-sdk/s3-request-presigner` 3.1171.0, all past the two-day release-age rule. They grow the worker image from 448 MB to 520 MB (measured with `docker images`); the built image wires the live adapters as expected in live mode.

### D-090 Embeddings: Cohere Embed Multilingual v3

- **Checked on 2026-11-20** (Bedrock model cards): `cohere.embed-multilingual-v3` runs in-region in Mumbai, is billed through AWS Marketplace, returns 1,024 floats (our column), takes 96 texts a call and 512 tokens a text (our passages are at most 1,200 characters).
- **Chosen** because cross-language retrieval is the main quality risk (D-060): customers ask in Hindi, Malayalam and Arabic about knowledge written in English. Documents are embedded as `search_document` and questions as `search_query`, which Cohere embeds differently on purpose.
- **Rejected:** Titan Text Embeddings V2 (AWS warns that cross-language queries are sub-optimal), and Cohere Embed v4, which Mumbai reaches only through the global profile, so requests may leave the region.
- **Relevance floor:** 0.25, a starting value; the retrieval evals (phase 8) set it from measurements.

### D-091 Transcribe: batch jobs on our S3 copy of the voice note

- **Flow:** start a job named `voice-{messageId}` on `s3://{bucket}/tenants/{t}/media/{id}`. With one business language it names that language; with several it identifies among only those (`IdentifyLanguage` and `LanguageOptions`). The transcript goes to `tenants/{t}/transcripts/{id}.json` in our bucket and is read, then deleted along with the job: the text lives on the message, not in two places.
- **Retries:** the adapter polls every 2 s for up to 90 s, then lets the transcription job retry. A retry finds the job already started (`ConflictException`) and waits for it, so a note is never transcribed twice. A failed job, an unsupported format (AAC is not in Transcribe's list) or no speech hands the note to a person (D-074).
- **Open, and the main risk of this phase:** the batch documentation lists "Ogg" without naming the codec, and lists Ogg Opus only for streaming. WhatsApp voice notes are Ogg Opus. The live contract test (D-096) answers this on its first run, because it transcribes a real Polly Ogg Opus note. If batch rejects it, the options are the streaming API (which does list Ogg Opus) or converting to FLAC, and I will bring them to you. Until then a rejected note still reaches a person.
- **Rejected for now:** streaming transcription. The brief describes S3 then Transcribe, and streaming is a long-lived HTTP/2 connection per note for a gain in latency nobody has measured yet.

### D-092 S3 storage, and playback through short-lived links

- **Chosen:** in live mode with `MEDIA_BUCKET` set, media and knowledge files go to S3 with SSE-S3 encryption on every write (the bucket also encrypts by default, phase 9). Without a bucket, live mode uses local disk and voice notes go to a person, because Transcribe can only read S3.
- **Playback:** `/api/media/:id` still checks the tenant, then redirects to a presigned GET that lives `MEDIA_URL_TTL_SECONDS` (300 s). The link fixes `Content-Type` and `Content-Disposition` in its signature, so a customer's HTML or SVG still downloads instead of rendering. The web build's content policy admits the bucket's origin through `MEDIA_ORIGIN`, a build argument (phase 9 passes it).
- **The seed** uses the same storage and embedder factories as the apps, so a live seed stores files in S3 and embeds with Cohere.

### D-093 Only vectors from the same model are compared

- **Fixed:** retrieval's semantic half compared a query with every passage, whatever model embedded it. Vectors from two models are not comparable, so it now filters on the passage's recorded model. The keyword half is unchanged.
- **Re-embedding:** at start-up the worker finds knowledge sources whose passages another model made (`requeue_stale_embeddings`), gives each a new version and queues it. Old passages keep serving keyword search until the new ones replace them in one transaction. This makes a model change (mock to Cohere, or a newer Cohere) a restart, not a migration.
- **Not covered:** files stored on local disk before a switch to S3 are not copied over.

### D-094 Each business's WhatsApp token, sealed (P-04 built)

- **Chosen:** the owner enters the phone number ID, the WhatsApp Business Account ID, the number as customers see it, and a system-user token. The token is sealed with AES-256-GCM under `CREDENTIALS_KEY` (32 bytes, from SSM in production) and bound to its phone number ID as additional data, so a sealed token copied onto another number does not open. It is never returned to a browser, and the audit entry records only that it changed. Saving without a token keeps the saved one.
- **Platform-wide, unchanged:** the Meta app secret and the webhook verify token (one Meta app for the platform). `META_ACCESS_TOKEN` is gone: each send opens the token of the number it goes through.
- **Rules:** live mode only (in mock mode the form says why); one Meta number per business in v1; a number already connected to another business is refused. Row-level security hides that row, so the unique constraint is what catches it.
- **Rejected:** AWS KMS envelope encryption: stronger key custody, but a new cloud resource and a per-call cost (you chose the SSM key).

### D-095 Claude in Amazon Bedrock: the adapter's choices

- **Checked on 2026-11-20** (Anthropic's "Claude in Amazon Bedrock" page and the installed SDK's types): `AnthropicBedrockMantle({ awsRegion })` calls `bedrock-mantle.{region}.api.aws` with the Messages API, and credentials fall back to the default AWS chain, so the instance role is enough. Mumbai is served by the global endpoint, with no premium. `anthropic.claude-haiku-4-5` is open to every Bedrock account; `anthropic.claude-haiku-5-5` needs access granted first.
- **Errors:** 400, 401, 403, 404 and 422 hand the conversation over at once (no access, wrong model, rejected request). Throttling, timeouts and server errors are retried, by the SDK twice and then by the assistant job.
- **Output:** the prompt asks for a final JSON object. The adapter takes the last complete object in the text; anything else fails validation, and the conversation goes to a person.
- **Prices:** the table keeps Anthropic's list prices for both Haiku models. AWS's price page did not show them on 2026-11-20, so they are unconfirmed against an AWS bill. Embedding, Transcribe and Polly costs are not recorded per turn yet.

### D-096 One contract suite, mock always, live on request

- `packages/pipeline/src/contract.test.ts` states what every adapter must do: the model answers a grounded question in the agreed shape; embeddings have 1,024 dimensions and put a question nearer its answer; storage keeps, returns and forgets an object; speech comes out as playable Ogg Opus under 512 KB and goes back to the right words in the right language.
- The mock adapters run it in every `make check`. The live ones run only with `LIVE_CONTRACT=1` and AWS credentials (`pnpm --filter @app/pipeline run contract:live`), never in CI, so automated tests still never call a paid API. Its voice check chains Polly into S3 into Transcribe, the same path a customer's note takes.
- **Also offline:** each adapter's requests are checked against the documented shapes with fake SDK clients (`packages/live/test`). S3 presigning runs for real, since signing needs no network.

### Known gaps after phase 7

- **Nothing has run against AWS yet.** Before live mode works end to end, a first live contract run needs: access to Haiku 5.5 in Bedrock (or `BEDROCK_CHAT_MODEL=anthropic.claude-haiku-4-5`), the Cohere Marketplace subscription, a bucket, and credentials. The open questions are Ogg Opus in batch Transcribe (D-091) and whether the current SDK works with Haiku 4.5 (D-059).
- **P-09** (detect a customer's language once, then reuse it) is still a proposal: Transcribe identifies among all of the business's languages on every note.
- **WhatsApp:** the token is not checked against Meta when saved, and changing a business's number is not supported yet.
- **Relevance floor** for Cohere is a placeholder until the evals.

## Phase 8: evals and load test (2026-11-20)

Approved on 2026-11-20: P-10 with Claude Sonnet as the judge for groundedness and language, spot-checked by hand. As in phase 7, nothing paid ran: the live eval waits for credentials.

### D-097 A reply answers messages up to its turn's trigger (bug found by the load test)

- **Found:** the first load test left 29 of 200 customers unanswered. A turn treated every customer message older than the latest outbound message as answered. But a reply is stored when its turn finishes, so a message that arrived while the previous turn was still running looked answered and never got its own turn. The safety sweep used the same rule, so it could not help. And it re-queued with the message's own job ID, which BullMQ keeps after the first job finishes, so the re-queue did nothing anyway.
- **Fixed:** what a turn answers is now computed from turns. An assistant reply covers the customer's messages up to its trigger message; a person's reply, or an assistant reply with no turn (seeded history), covers everything before it; a turn that sent nothing still covers its trigger. The comparison runs in SQL, because timestamps carry microseconds that a JS `Date` drops, and the first version of the fix tripped on exactly that. The sweep function uses the same rule, and sweep jobs get their own job ID.
- **Proved:** a new integration test makes the first turn slow and sends a second message mid-turn. It fails on the old code and passes on the new. The load test has passed on every run since (three in a row).
- **Remaining:** if a turn runs longer than the 1.5 s debounce and the next message's own turn starts before it finishes, both turns reply: the customer gets two answers, the second covering both messages. That is better than no answer. Serialising turns per conversation would mean holding a lock across the model call; I'll revisit if the live run shows it.

### D-098 The evals: production code, a separate database, scripted cases

- **54 cases** (`evals/src/cases.ts`): 33 for Qamar Phone Corner and 21 for Kayal Bakes, in English, Hindi, Hinglish, Malayalam and Arabic. They cover knowledge answers, prices from the catalogues, own orders, someone else's order, a missing order, asking for a person, complaints, escalation words, custom quotes, off-topic requests and prompt injection. Every expectation follows the seeded knowledge.
- **How a case runs:** it becomes a real conversation in a copy of the demo business (same knowledge, orders and settings) in its own database, `app_eval`, recreated each run so dev data and analytics are untouched. `runAssistantTurn`, the function the worker calls, answers it, and the stored turn is read back as the trace.
- **Checks:**
  - Handoff and decline come straight from the recorded turn. Handoff is scored only where the right answer is clear; "not in the knowledge base" may hand over or not.
  - Groundedness requires the case's facts, forbids its leaks, and in live runs needs the judge's agreement.
  - Language is judged in live runs and detected by script in mock runs.
- **Judge:** a stronger Claude than the models graded (`EVAL_JUDGE_MODEL`, default `anthropic.claude-sonnet-5-5`; check the ID in Bedrock before the first run). It sees the customer messages, the evidence the assistant was shown, the reply and the expected language. Its verdict and reason are stored, and one case in five is listed for a hand spot-check; the agreement rate is written in once a person has checked.
- **Commands:** `pnpm eval` runs live, on Haiku 5.5 and Haiku 4.5, with the judge. `pnpm eval:mock` runs offline and puts a warning at the top of `docs/EVALS.md`: mock numbers test the machinery, not quality. Both write `docs/EVALS.md` from the stored traces (reply time, tokens, cost per conversation) and keep the raw results in `evals/results/` (not committed).
- **Seed fix found while writing cases:** the demo opening hours (phase 6) contradicted the businesses' own FAQs, so a correct model would have seen two answers. The hours now match the FAQs.

### D-099 The load test proves nothing is lost or duplicated, from both sides

- **What it does:** `pnpm load-test` drives a running stack (`make dev` or `make up`) through the simulator's control API. It sets up its own business and 200 customers (half with only a username), switches on faults (20 % duplicate webhooks, 300 ms reordering, 100 ms delay, 5 % failed sends, 5 % rate limits), and sends 1,000 messages in five waves.
- **What it checks:**
  1. Every message is stored once, by WhatsApp message ID.
  2. Every reply is sent, and appears once on the customer's phone in the simulator's record, with nothing on a phone we did not send.
  3. Replies arrive in order per conversation.
  4. Every customer's last message got a turn.
  5. All of it settles within 5 minutes.
- **Result on this laptop, mock mode:** all checks passed, three runs in a row after D-097. `docs/LOAD-TEST.md` holds the last run's numbers, including reply time from the stored traces and the retries the faults caused. They are not EC2 numbers; phase 9 runs it there.
- **Rejected:** k6 or autocannon. The checks need our database and the simulator's records, which a plain HTTP load tool does not see, and they would be another dependency.
- **The simulator gained** `POST /control/businesses` and `POST /control/customers`, so a load test brings its own number and customers.

### Known gaps after phase 8

- **No live numbers yet.** `pnpm eval` needs AWS credentials, Haiku 5.5 access, the Cohere subscription and the judge model's ID checked; it costs money, so it runs only when you say. Until then `docs/EVALS.md` holds a mock run, marked as such.
- **Judge and embedding costs** are not in the cost per conversation.
- **Two replies** in the rare overlap described in D-097.

## Proposed, awaiting approval

These came out of the first review of the brief. Approved on 2026-11-17 and built in phase 1: P-03 (no email; invites and reset links move to phase 6 with settings), P-08, P-11 (Radix arrives with the first menu or dialog) and P-12. P-01 and P-02 were approved and built in phase 2 (D-034, D-038). P-06 and P-07 were approved on 2026-11-20 and built in phase 4 (D-067, and D-065's notices for media). P-09 applies to the live Transcribe adapter (phase 7). P-05 was approved and built in phase 6 (D-087), and P-04 was moved to phase 7, both on 2026-11-20. P-04 was built in phase 7 (D-094). P-10 was approved and built in phase 8 (D-098), with Claude Sonnet as judge; its live run waits for credentials. Still open: P-09.

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
