# Build brief: WhatsApp AI support desk

Read this whole brief before you do anything. Then follow section 10, "How we work".

## 1. Context

I am a senior full-stack developer with five years of experience. This is the flagship project of my portfolio. The people judging it are hiring managers and senior engineers. They will read the code, the README and the commit history, and they will click through the live demo. They are looking for judgment: clean boundaries, failure handling, tests, security, measured results and stated trade-offs.

Two things follow from that:

- Quality beats breadth. When scope and quality conflict, cut scope and tell me what you cut.
- I have to defend every decision in an interview. Prefer simple, conventional solutions. Record each significant choice, the alternative you rejected and the reason in `docs/DECISIONS.md`.

## 2. Product

A multi-tenant SaaS for small businesses. A business connects its WhatsApp number, and an AI assistant answers its customers using only that business's own knowledge: FAQs, catalogue, policies and order status. When the assistant is unsure, or the customer asks for a person, the conversation moves to a human agent in a live web inbox. The agent can take over, reply and hand the conversation back.

Roles: platform admin, tenant owner, tenant agent. Customers only ever use WhatsApp.

In scope for v1:

1. Sign-in, roles and strict tenant isolation.
2. WhatsApp pipeline: receive and send text; receive images and documents; voice notes both ways.
3. Live inbox: conversation list, thread, take over, hand back, assign, internal notes.
4. Knowledge base: upload documents and FAQ entries; chunk, embed, retrieve.
5. Assistant: grounded replies, handoff, one tool (order-status lookup against a sample tenant API), replies in the customer's language.
6. An "explain this reply" panel: the passages retrieved, the tools called, latency, tokens and cost for any assistant message.
7. Analytics: share of conversations resolved without a human, response times, handoff reasons, cost per conversation.
8. Tenant settings: business profile, opening hours, assistant tone, escalation rules, languages, voice replies on or off.
9. A local simulator (section 5).

Out of scope: billing, broadcast or marketing campaigns, other channels, a mobile app, SSO.

## 3. Stack (decided)

These choices are made. If you see a real problem with one, say so before building on it.

| Layer | Choice |
|---|---|
| Repo | pnpm monorepo: `apps/web`, `apps/api`, `apps/worker`, `apps/simulator`, `packages/shared` |
| Web | Next.js (App Router) + TypeScript, strict mode |
| API | NestJS + TypeScript; zod schemas shared with the web app |
| Database | PostgreSQL with pgvector; row-level security per tenant; a SQL-first query layer (Drizzle or Kysely) |
| Queue | Redis + BullMQ |
| Real time | WebSocket gateway, authenticated and scoped per tenant |
| AI model | Claude Haiku 5.5 on Amazon Bedrock through the Converse API. The model ID comes from `BEDROCK_MODEL_ID`; Claude Haiku 4.5 must work by changing only that value |
| Embeddings | A multilingual embedding model on Bedrock; check the current model list and record the choice |
| Speech to text | Amazon Transcribe (incoming voice notes) |
| Text to speech | Amazon Polly (voice replies) |
| Files | Amazon S3, private bucket, presigned URLs |
| Hosting | Docker Compose on one EC2 instance, Caddy for TLS |
| Infrastructure | Terraform; GitHub Actions for CI and deploy |
| Auth | Email and password with httpOnly session cookies, using a maintained library. No hosted auth service, so mock mode stays offline |

## 4. Architecture rules

**Tenant isolation.** Every tenant-owned table has `tenant_id` and a row-level security policy. The application connects with a database role that cannot bypass it and sets the tenant per transaction. Write tests that prove tenant A cannot read or change tenant B's data through the API, the WebSocket or a background job.

**Inbound pipeline.** Verify the webhook handshake. On each POST, verify the `X-Hub-Signature-256` HMAC against the raw body, store the raw event, return 200 quickly, and do the work on the queue. Deduplicate on the WhatsApp message ID with a unique constraint. Expect duplicates, out-of-order delivery and status events (sent, delivered, read, failed).

**Outbound pipeline.** Keep replies in order within a conversation. Retry with backoff, and move exhausted jobs to a dead-letter queue the admin can see. Respect the 24-hour customer service window: free-form replies inside it, an approved template outside it. Show the window state in the inbox.

**Conversation ownership.** A conversation is in exactly one state: `assistant`, `waiting_for_human`, `human` or `closed`. Log every transition with who made it and why. The assistant never sends while a human holds the conversation.

**Assistant.**

- Answer only from retrieved knowledge or tool results. If the answer is not there, say so and offer a person. Never invent prices, stock, policies or delivery dates.
- Use tool calls for `lookup_order` and `handoff`.
- Stay on the tenant's business. WhatsApp's Business terms prohibit general-purpose AI assistants, so the assistant politely declines unrelated requests.
- Treat customer messages and uploaded documents as data, never as instructions. Add tests with prompt-injection attempts in both.
- Reply in the customer's language, in short plain text that reads well on WhatsApp.
- Enforce a per-tenant daily token budget and a per-customer rate limit. Record tokens, latency and cost for every turn.
- Mask phone numbers and message text in logs.

**Voice.** Incoming audio goes to S3, then to Transcribe, with language identification limited to the tenant's languages. Show the transcript beside an audio player in the inbox. For voice replies, synthesize with Polly as `ogg_opus`, upload the media, and send it as a WhatsApp voice message. Always store the text as well. If Polly has no voice for the language, reply in text.

**Storage.** Keys are prefixed `tenants/{tenantId}/`. Encrypt at rest. Inbox playback uses short-lived presigned URLs. Add a lifecycle rule that expires media after a configurable number of days.

**Hosting.** One ARM EC2 instance with about 4 GB of memory runs `web`, `api`, `worker`, `postgres`, `redis` and `caddy`. Only ports 80 and 443 are open; use Session Manager, not SSH. The instance role grants least-privilege access to Bedrock, Polly, Transcribe and S3, so there are no long-lived AWS keys. Secrets live in SSM Parameter Store. CI builds images, pushes them to ECR and deploys through SSM. Back up Postgres to S3 every night and document a tested restore. In the README, state the single-instance trade-off and the upgrade path: RDS, a second instance, a load balancer.

## 5. Run modes: mock and live

I must be able to run and test the whole product on my laptop with no AWS account, no Meta account and no internet connection. This is a hard requirement. It also keeps the tests free and deterministic.

Put every external system behind an interface, with two implementations selected by `APP_MODE=mock|live`:

| Interface | Live | Mock |
|---|---|---|
| WhatsApp gateway | Meta Cloud API | The simulator (below) |
| Chat model | Bedrock | A deterministic scripted model that answers from the retrieved passages and triggers handoff on set cues. Optional third adapter: Ollama |
| Embedder | Bedrock | A deterministic local embedding, good enough for keyword-level retrieval |
| Speech to text | Transcribe | Returns the transcript the simulator attached to the voice note |
| Text to speech | Polly | Returns a bundled short OGG/Opus clip |
| Object storage | S3 | Local disk behind the same interface |

**The simulator** (`apps/simulator`) is a small service that mimics the parts of Meta's API we call: send message, upload media, download media. It also has a phone-style chat page where I play the customer. It posts webhook events to our real webhook endpoint in Meta's exact payload format, signed with a test secret. The product code is therefore identical in both modes; only the base URL and the secret differ.

The simulator must be able to:

- run several customers at once;
- send text, images and voice notes;
- emit delivery and read statuses;
- inject faults on demand: duplicate delivery, out-of-order events, delays, failed sends, rate-limit errors.

I will use the fault controls to demonstrate idempotency and retries.

Requirements:

- `make dev` starts everything in mock mode with seeded data: two demo tenants with knowledge bases, users and realistic conversation history.
- Mock mode makes zero outbound network calls. Add a test that fails if it does.
- One contract test suite runs against both mock and live adapters. Live tests run only when I pass credentials and an explicit flag.
- Automated tests never call a paid API.
- Build the simulator well enough to deploy as the public "try it in your browser" demo.

## 6. Interface design

The interface must look designed by a person with a point of view. Reviewers have seen hundreds of AI-built dashboards and recognise them at a glance.

**Process.** Before writing any UI code, write `docs/DESIGN.md` and show it to me:

1. Palette: four to six named hex values, with the job of each.
2. Type: a display face used sparingly, a body face, and a utility face for IDs, times and numbers.
3. ASCII wireframes for the inbox, a conversation thread, the knowledge base and analytics.
4. One signature element the product will be remembered by.

Then review your own plan. If any part is what you would produce for any SaaS dashboard, replace it and tell me what you changed. Wait for my approval before building. If a frontend design skill is available in your environment, load it first.

**Direction.**

- Ground the look in the subject: a service counter for small shops and clinics in India and the Gulf. Think of order slips, queue tokens, ledgers and courier labels.
- The core idea of the product is who is holding the conversation, the assistant or a person. A strong candidate for the signature element is making that ownership visible at a glance, on every thread and in the list.
- This is a working tool used all day: dense, calm, fast and keyboard-first. A three-pane inbox, not a marketing page with KPI tiles.
- One light theme, done well.

**Avoid.**

- Purple, indigo or blue-violet gradients; gradient text; glows; glassmorphism.
- Sparkle, robot or magic-wand icons for AI. Emoji used as icons.
- Cards nested in cards; the same large radius and soft shadow on everything; pill badges everywhere.
- A component library's default look left unchanged. Inter or the system font as the only typeface.
- Decorative numbering, stock illustrations, blobs, lorem ipsum.
- The three looks AI-generated design currently converges on: a cream background with serif headings and a terracotta accent; near-black with one acid-green or vermilion accent; newspaper-style hairlines with zero radius.
- WhatsApp's green, bubble shapes or logo. This must not look like an official WhatsApp product.

**Details that matter.**

- Real content everywhere: seed conversations in English, Hindi, Hinglish, Malayalam and Arabic. Message text uses `dir="auto"`. Check that Devanagari, Malayalam and Arabic scripts render in proper fonts.
- Design every state: loading, empty, error, reconnecting, window closed, a 2,000-character message, 300 conversations in the list.
- Copy: sentence case, plain verbs, buttons that say what happens ("Take over", "Hand back to assistant"). Errors say what went wrong and what to do next. Empty screens point to the next action.
- Motion only where it explains a change of state. Respect reduced-motion settings.
- WCAG AA contrast, visible keyboard focus, usable at 390 px wide.

**Check your work.** After building a screen, capture screenshots with Playwright at 1440 px and 390 px, compare them with `docs/DESIGN.md`, and fix what falls short before you tell me it is done.

## 7. Engineering standards

- TypeScript strict. No `any` without a comment explaining why.
- Validate at every boundary: HTTP input, webhook payloads, queue job data, model output.
- Tests: unit tests for domain logic; integration tests against real Postgres and Redis in containers; Playwright end-to-end tests that drive the simulator and the inbox together.
- CI on every push: lint, typecheck, tests, image build. Keep it under ten minutes.
- Migrations are versioned. `.env.example` documents every variable. No secrets in the repo.
- Structured JSON logs carrying a request ID and a conversation ID. Health and readiness endpoints.
- Security basics: rate limiting, secure headers, CSRF protection, password hashing with a current algorithm, and an audit log for ownership changes and settings changes.

## 8. Evidence

The README needs measured results, so build the means to measure them:

- `evals/`: about 50 scripted customer conversations across the two demo tenants, in several languages. Score each on four checks: answer grounded in the knowledge base, correct handoff decision, out-of-scope request declined, language matched. `pnpm eval` runs them against live Bedrock and writes a results table to `docs/EVALS.md`.
- A load test that pushes 1,000 messages through the simulator with faults switched on and proves none are lost or duplicated.
- From stored traces: median and p95 reply time, and cost per conversation.

Report the real numbers, including the weak ones. Never put a number in the README that a script did not produce.

## 9. Authorship and git

I am the only author and contributor of this repository.

- Commit as my configured git user. Never change `user.name` or `user.email`, and never pass `--author`.
- Never add a `Co-Authored-By` trailer, a "Generated with" line, or Claude or Anthropic as an author, committer, co-author or contributor anywhere: commits, pull requests, `package.json`, README, licence or contributor files.
- Enforce this mechanically. Add `.githooks/commit-msg` that rejects any message matching `co-authored-by:.*(claude|anthropic)` or `generated with.*claude` (case-insensitive), set `core.hooksPath` to `.githooks`, and add a CI step that checks every pushed commit the same way.
- Small commits in Conventional Commits style, each leaving the tests green.
- Do not push, open pull requests, create cloud resources or deploy until I say so.

## 10. How we work

1. First reply: write no code. Give me (a) your understanding of the product in five lines, (b) the risks or gaps you see in this brief, (c) the questions you need answered, and (d) your phase plan. Wait for my go-ahead.
2. Keep this brief at `docs/BRIEF.md`. Put the rules that apply to every session (sections 4, 5, 6, 7 and 9, condensed) into `CLAUDE.md` so later sessions keep them.
3. Work one phase at a time. At the end of each phase, run the full test suite, update `docs/DECISIONS.md`, tell me what you built, what you skipped and what worries you, then stop for my review.
4. Check external APIs against their official documentation before coding against them: Meta's WhatsApp Cloud API, Bedrock, Polly and Transcribe. Do not rely on memory for endpoints, payload shapes, model IDs or limits.
5. Ask before adding a paid service or a major dependency.
6. If something in this brief is wrong or contradictory, say so. I would rather hear it than have you work around it.

Phases:

0. Foundations: monorepo, Compose, CI, git hook, `CLAUDE.md`, design plan.
1. Tenancy and auth, with isolation tests.
2. Simulator and the WhatsApp pipeline in mock mode.
3. Inbox with live updates, take over and hand back.
4. Knowledge base and assistant, with the "explain this reply" panel. Build the Bedrock adapters here, because prompts can only be tuned on the real model.
5. Voice notes in and out.
6. Analytics and tenant settings.
7. Remaining live adapters: Meta, Transcribe, Polly, S3.
8. Evals and load test.
9. Terraform, EC2 deploy, backups, runbook.
10. README: architecture diagram, trade-offs, measured results, two-minute demo script.

## 11. Facts checked in November 2026

Re-verify each one in the official docs before relying on it.

- Bedrock: Claude Haiku 5.5 is `global.anthropic.claude-haiku-5-5`; Mumbai is served through the global profile only. Claude Haiku 4.5 is `global.anthropic.claude-haiku-4-5-20251001-v1:0`, with an India-only profile at `in.anthropic.claude-haiku-4-5-20251001-v1:0`.
- Polly: supports `ogg_opus` output at 48 kHz. Its Indian voices cover Indian English and Hindi only. Gulf Arabic is available. There is no Malayalam voice.
- Transcribe: Hindi, Indian English and Malayalam are supported for batch jobs.
- WhatsApp voice messages: OGG with the Opus codec, mono, up to 16 MB, sent as an audio message with `voice: true`.
- WhatsApp policy: since 15 January 2026, general-purpose AI assistants are not allowed on the Business API. Business customer support is allowed.

## 12. Done means

- `make dev` gives a working product in mock mode on a clean machine, offline.
- All tests pass in CI, including the isolation, idempotency and prompt-injection tests.
- The live deployment works end to end with a real WhatsApp number.
- `docs/EVALS.md` and the README carry measured results.
- Every commit is authored by me alone.