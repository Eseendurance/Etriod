# ETriod — full-stack app

A Node/Express + PostgreSQL application with private, self-hosted AI inference.
Conversation content is sent only to the configured Ollama-compatible model
endpoint; it is not sent to an AI vendor API.

## What's real and verified here

- **Auth**: email/password, bcrypt-hashed, JWT sessions, password reset via
  emailed token, email verification on signup (both with hashed, expiring,
  single-use tokens — not just a flag).
- **Database**: PostgreSQL schema (`schema.sql`) — users, conversations,
  messages, password resets, email verifications, waitlist signups,
  subscriptions.
- **AI**: uses an Ollama-compatible self-hosted server configured with
  `OLLAMA_BASE_URL` and `OLLAMA_MODEL`. No Anthropic SDK, API key, or model
  vendor API is used. Context is capped to 40 messages; input is capped at
  8,000 characters.
- **Billing**: Stripe, Flutterwave, and Paystack hosted checkout with signed
  webhooks and server-side transaction verification before activation.
- **Admin**: separate platform-wide company and billing analytics, gated by a
  real `role='admin'` column.
- **Company workspaces**: paid Team/Enterprise owners can create a tenant,
  invite existing accounts, assign owner/admin/member roles, remove members,
  and view workspace-only usage. Company admin privileges do not grant access
  to the global platform dashboard.
- **Rate limiting**: 10 attempts / 15 min on login, signup, and password
  reset requests (brute-force protection); 20 messages / minute on chat
  (cost control). Counters are stored in PostgreSQL so limits are shared
  across API replicas instead of resetting per process.
- **Security headers** via Helmet; **request logging** via Morgan.
- **Graceful shutdown**: SIGTERM/SIGINT close the HTTP server and the DB pool
  cleanly instead of dropping in-flight requests — matters for zero-downtime
  deploys.
- **Crash resilience**: the Postgres pool's `error` event is handled — a
  dropped idle connection no longer takes down the whole process (this was a
  real bug in the previous version, found and fixed this pass).
- **Real health check**: `/health` actually queries the database, not just
  "is the process alive."
- **Pagination**: conversation lists support `?limit=&offset=` instead of
  loading everything at once as the account grows.
- **Docker**: `Dockerfile` + `docker-compose.yml` bring up the API and a real
  Postgres together with one command for local development.
- **Vercel**: Express function serves the API and existing client pages under
  the same deployment origin; a protected daily cron purges expired transient
  records.

## What I found and fixed in this review pass

1. **Crash bug**: an unhandled `error` event on the Postgres connection pool
   would crash the entire Node process on any dropped connection. Fixed with
   a listener in `server/db.js`.
2. **Unbounded chat context**: every message was re-sending the *entire*
   conversation history to the model — cost and latency would grow without
   limit, and eventually exceed context limits. Capped to the most recent 40
   messages.
3. **No rate limiting anywhere**: login was brute-forceable, and chat had no
   cost ceiling per user. Added `express-rate-limit` on both.
4. **No password reset flow**: dead end for any user who forgot their
   password. Added a full request/confirm flow with hashed, expiring tokens
   and no account-enumeration leak.
5. **Fragile pagination**: conversation lists were hard-capped at 200 with no
   way to page further. Added `limit`/`offset` query params.
6. **No graceful shutdown**: a deploy or restart would drop in-flight
   requests. Added SIGTERM/SIGINT handling.
7. **No real health check**: `/health` said "ok" even if the database was
   unreachable. It now runs an actual query.

All of the above were verified with an expanded automated test
(`npm test`, covering the API, migrations, and error tracking against an
in-memory Postgres) plus a manual run of the real server that confirmed the
rate limiter genuinely returns 429 on the 11th rapid login attempt and the
health check genuinely returns 503 when the database is unreachable.

## The full frontend, all wired to the real API

`client/` now has every page, all pointing at your real backend instead of
the earlier sandbox prototype:

| Page | What it does |
|---|---|
| `login.html` | Sign in / create account, forwards to onboarding or the app |
| `welcome.html` | First-time onboarding, saves real preferences via `/api/settings` |
| `app.html` | The chat app itself — real conversations, real AI replies |
| `settings.html` | Profile, preferences, email verification banner, clear-history |
| `admin.html` | Real usage stats, gated by the `role='admin'` column |
| `company.html` | Company-specific activity and owner/admin/member controls |
| `templates.html` | Prompt gallery — deep-links into `app.html?q=...`, surviving a login redirect if needed |
| `pricing.html` | Configured gateway checkout plus the Team/Enterprise waitlist |
| `hub.html` | One directory linking every page above |
| `landing.html` / `landing-v2.html` | Two marketing page variants |
| `help.html` | Searchable FAQ |
| `forgot-password.html` / `verify-email.html` | Real password reset and email verification flows |

Open `client/hub.html` as your starting point to click through everything.

## What you still need to do before this is live

The project includes a Vercel deployment configuration, but a successful
deployment still requires production credentials and infrastructure.

1. **Vercel project**: import this repository in Vercel and keep the root
   directory at the repo root. `vercel.json` configures the Express function
   and daily maintenance cron. Vercel functions are stateless; do not depend
   on the Docker Compose services for deployed storage or inference.
2. **PostgreSQL**: provision managed PostgreSQL with SSL and a serverless
   pooler endpoint (for example a provider's pooled Neon URL). Configure
   `DATABASE_URL` in Production, Preview, and Development environments as appropriate.
   Before routing production traffic, run `npm run db:migrate` from a trusted
   release environment against that database. Do not run schema migrations
   concurrently inside every serverless request.
3. **Self-hosted model runtime**: run Ollama on a secured host reachable over
   HTTPS from Vercel, or through a private network/tunnel. Configure
   `OLLAMA_BASE_URL` and `OLLAMA_MODEL`; do not expose Ollama's unauthenticated
   port to the public internet. Function timeout must be compatible with
   inference duration (`vercel.json` defaults to 60 seconds and the model
   request timeout defaults to 50 seconds); longer generations may need a
   separately hosted inference gateway.
4. **Payment credentials** for the gateway(s) you enable, including provider
   plan IDs, amounts, currencies, and webhook signing secrets.
5. **An SMTP server you operate** if account verification/reset emails should
   be delivered. Development links are logged when SMTP is not configured.
6. **Vercel environment variables**: set `JWT_SECRET` to a strong random
   secret, `APP_URL` to the deployed origin, `ALLOWED_ORIGINS` to that origin,
   `CRON_SECRET` to a separate random secret, plus mail and payment settings.
   The same origin serves frontend and API; do not set client-side secrets.
7. **Deployment operations**: attach a production domain, configure payment
   webhooks to that domain, set database backups/retention, and test preview
   deployments against a separate non-production database. The cron endpoint
   is protected by `CRON_SECRET`.
8. **A real domain, HTTPS, Terms of Service, and a Privacy Policy** — ideally
   reviewed by a lawyer before real user data touches this.
9. **Promote your own account to platform admin**, once deployed:
   `UPDATE users SET role = 'admin' WHERE email = 'you@example.com';`

On Vercel, the install/build settings can remain at their defaults. Run
migrations as a separately controlled release step; do not run database DDL
during builds or let simultaneous preview deployments migrate production.

Configure these webhook URLs in the corresponding payment dashboards:

- Stripe: `/api/billing/webhook`
- Flutterwave: `/api/billing/flutterwave/webhook`
- Paystack: `/api/billing/paystack/webhook`

Set recurring Team-plan products in each provider before enabling its
environment variables. Flutterwave and Paystack are not enabled on the pricing
page unless the required server-side credentials and plan settings are present.

## Private inference and payments

The private model adapter and payment-provider flows are implemented and
covered by the project tests:

- **Streaming chat responses** — `POST /api/conversations/:id/stream`
  streams the reply token-by-token over Server-Sent Events instead of
  waiting for the full response. `app.html` now consumes it directly (no
  more waiting on a spinner for a long reply). Verified end-to-end against a
  mocked local model server: deltas reconstruct the full text, a `done` event
  fires, and the assembled reply is persisted to the database.
- **Schema migrations** — `scripts/migrate.js` tracks applied migrations and
  runs new schema changes transactionally. Run `npm run db:migrate` or
  `npm run db:migrate:status`.
- **Local diagnostics** — errors stay in this server's logs; the external
  Sentry SDK and reporting path have been removed.
- **Three payment gateways** — hosted checkout and provider-signed webhooks;
  the backend verifies successful transactions before activating Team.
- **Horizontal rate-limit sharing** — API replicas use atomic PostgreSQL
  counters, so scaling out does not multiply login or chat request limits.
- **No remote fonts or photos** — client pages use system fonts; the service
  worker caches only the static shell and never private API responses.
- **Team role isolation** — company owner/admin/member roles are separate from
  platform admin access, and company access is checked against the owner's
  current Team/Enterprise entitlement.
- **Legacy company ownership** — for organizations created before roles were
  tracked, the migration assigns ownership to the oldest linked account
  because the old schema did not record a creator. Review migrated owners
  before inviting team members.
- **Revenue analytics** — captured payment amounts and timestamps are stored
  only after provider verification. Platform analytics group revenue by
  provider and currency rather than combining incomparable currencies.
- **Vercel scheduled cleanup** — the daily cron uses `CRON_SECRET` and expires
  old rate-limit counters and one-time auth tokens.

## Recommended next additions (not yet built)

- **A CDN in front of the static frontend** for global latency once you have
  users outside one region.
- **Automated tests running in CI** (GitHub Actions or similar) on every
  push — `npm test` already exists and is fast; it just isn't hooked to
  anything that runs it automatically yet.

## Local development

```bash
Copy-Item .env.example .env # configure database, local model, and payment gateways
npm install
npm run db:migrate          # applies migrations/ to your database
npm run dev                 # starts the API on :3000
```

Or with Docker (brings up Postgres too):

```powershell
Copy-Item .env.example .env
docker compose up --build
```

Download the model into the private Ollama service once:

```bash
docker compose exec ollama ollama pull llama3.2:3b
```

Then open `client/login.html` through the app or a static server. The browser
connects to the app backend; the backend connects to the self-hosted model.

## Verifying it yourself

```bash
npm test
```

Runs `smoke-test.js`, `migrate-test.js`, and `error-tracking-test.js` against
the route code and an in-memory Postgres — signup, email verification
(including token reuse rejection), login, wrong password, duplicate email,
session auth, conversation creation, cross-user data isolation (a second
user cannot read the first user's conversations), settings persistence,
password reset request/confirm, admin access control (denied until the role
is actually set), an oversized message being rejected before it reaches the
model, and history clearing actually deleting rows. It's a development
check, not a replacement for testing against real Postgres, local model
hardware, or live payment-provider credentials before launch.

## Still static, no backend needed

`help.html` is intentionally pure static content — an FAQ page has no data
to fetch. Everything else with a form, a login wall, or usage data now talks
to the real API.
