# Starter

<!-- boilerplate:start -->
## Using this boilerplate

```
cp -r bun-backend my-app && cd my-app
bun scripts/init.ts my-app      # renames the placeholder everywhere, installs, formats, removes itself
git init
```

`init` replaces the placeholder (`starter`, `Starter`, `STARTER`) in every file: the package scope
(`@my-app/*`), the compose project and container names, the database name and password, the OTel
service name and the problem-type URN, so the new project starts green. Then follow "Run it
locally" below.

Keep the ports (46xx) or change them in `deploy/compose.yaml`, `.env.example` and
`apps/api/src/bootstrap/config.ts`; they were picked to stay clear of other projects on one laptop.
<!-- boilerplate:end -->

A production-minded API on Bun: Hono on `Bun.serve`, Valibot, Drizzle on `Bun.SQL`, Valkey through
`Bun.redis`, InferDI for wiring, OpenTelemetry to a local Grafana stack, better-auth for accounts,
and Postgres row-level security on every owned row. It has no domain: add features as modules.

## What is in it

- **`apps/api`**: the HTTP shell. `bootstrap/` (config, container, runtime, app), `middleware/`
  (request context, error handler, security headers, session, validation), `infra/` (Valkey,
  better-auth, the rate limiter, the one-time code store, the mailer, runtime metrics),
  `shared/http/`, and `modules/<m>/` with `router/`, `use-cases/`, `repository/`, `consumers/`.
  The modules are `health` (`/healthz`, `/readyz`) and `auth`.
- **Accounts** (`auth` module over better-auth): email and password (Argon2id through
  `Bun.password`) with email verification, bearer sessions for native clients, Google sign-in for
  apps through the system browser (RFC 8252: one-time code in Valkey, PKCE exchange), `/me` with
  settings, sign out everywhere, account deletion behind the password. Sign-up is closed by
  `SIGNUP_ENABLED`; sign-in and sign-up are rate limited by a Lua token bucket in Valkey, keyed by
  the socket's address (never `x-forwarded-for`, which any client can set).
- **`packages/lib`**: `Result` and one error funnel with Problem Details, config validation, pino
  logging with redaction, OpenTelemetry setup (OTLP over gRPC by default), retry with full jitter,
  a circuit breaker, and `Resource` / `ResourceStack` for ordered start, drain and release.
- **`packages/db`**: `BunSqlDatabase` (cancellation by `AbortSignal`, spans and a slow-query log),
  `inTransaction`, `asUser` (a transaction as one user under forced row-level security, cancelled
  server-side on abort), migrations with a `db:migrate` command that keeps the API's login
  non-owner and non-superuser, test helpers that roll back.
- **`packages/contracts`**: the wire shapes as Valibot schemas with inferred types, and a sample
  for each.
- **`deploy/`**: compose with Postgres, Valkey and the Grafana stack (Prometheus, Loki, Tempo, an
  OTel Collector) and a provisioned "API overview" dashboard.
- **Rules that tests enforce** (`apps/api/test/structure.test.ts`, `duplicates.test.ts`): modules
  never import each other, routers call use cases, no inline object types in exported signatures,
  each type and value set is defined once, and more. `CLAUDE.md` lists them with the Bun traps found
  on the way.
- **Graceful shutdown** that is tested with a real `SIGTERM`: readiness flips to 503 at once, the
  server drains, resources release in reverse order, telemetry flushes last.

It follows the structure of akashic-records and the rules in the TypeScript-Tips skill.

## Run it locally

You need [Bun](https://bun.sh) 1.4 and Docker.

```
docker compose -f deploy/compose.yaml up -d --wait
cp .env.example .env          # then set AUTH_SECRET: openssl rand -base64 32
bun install
bun run db:migrate
bun run dev
```

Sign-up is closed by default: set `SIGNUP_ENABLED=true` to create an account, then set it back.
Until a mail provider is added (`MAIL_TRANSPORT=log`, refused in production), the verification
link is written to the API's log.

- API: http://127.0.0.1:4600 (`/healthz` answers when the process is up, `/readyz` when Postgres
  and Valkey answer too).
- Grafana: http://127.0.0.1:4630 (no login; opens on the API overview dashboard).
- Stop the stack with `docker compose -f deploy/compose.yaml down` (`-v` also drops its data).

Every port is bound to loopback only. Postgres is on 4632, Valkey on 4679, Prometheus on 4690,
Loki on 4610, Tempo on 4620 and the collector on 4617 (OTLP/gRPC) and 4618 (OTLP/HTTP).

`bun run check` runs format check, lint, typecheck and tests. Integration tests use the compose
Postgres and Valkey and skip themselves when those are not running.

### Telemetry protocol

`OTEL_EXPORTER_OTLP_PROTOCOL` picks how the API talks to the collector: `grpc` (the default, with
`OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4617`), `http/protobuf` or `http/json` (both with
`http://localhost:4618`). The endpoint is the bare address; the HTTP flavours add `/v1/<signal>`
themselves. A protocol aimed at the wrong port does not stop the API: exports fail and one warning
a minute says so.

### Grafana note

Bun exposes no GC numbers, so the dashboard shows heap size and capacity, event loop delay, CPU
and RSS, not garbage collection pauses.

## Not included yet

Background jobs, realtime and a real mail transport. `CLAUDE.md` notes where each one fits.
