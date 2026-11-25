# Starter

A Bun monorepo boilerplate for a production API: Bun 1.4, Hono, Valibot, Drizzle 1.0 rc,
Postgres 18, Valkey 8, InferDI, OpenTelemetry, better-auth. `apps/api` is the HTTP shell (config,
lifecycle, health, telemetry) with accounts (better-auth, bearer sessions, native Google sign-in,
`/me`) and row-level security through `asUser`; `packages/{lib,db,contracts}` are the shared
code. There are no domain features: add them as modules under `apps/api/src/modules/`.

Bun is usually off PATH here: `export PATH="$HOME/.bun/bin:$PATH"`.

## Commands (from the repository root)

```
docker compose -f deploy/compose.yaml up -d --wait   Postgres, Valkey and the Grafana stack (project starter)
docker compose -f deploy/compose.yaml down           stop it (add -v to drop the volumes)
bun run db:migrate     apply migrations as the owner (DATABASE_MIGRATION_URL), ensure the starter_api login
bun run db:generate    drizzle-kit generate (db:generate:custom for an empty SQL migration)
bun run dev            API with reload; reads ./.env (cp .env.example .env), port 4600
bun run check          format:check, lint, typecheck, test: what CI runs
bun run format         oxfmt apps packages
```

## Layout (`apps/api/src`)

```
main.ts          entry only
bootstrap/       config.ts, container.ts, runtime.ts, app.ts, types.ts (Module, Started, option types)
middleware/      request-context.ts, error-handler.ts, security.ts, session.ts (session, signedIn),
                 validate.ts (jsonBody, queryParams over a contract)
infra/           valkey.ts, runtime-metrics.ts, auth.ts (better-auth), auth-codes.ts, rate-limit.ts,
                 mailer.ts, types.ts
shared/http/     reply.ts, problem.ts, session.ts (requireUser), client-address.ts,
                 types.ts (HttpDeps, RequestContext, AppEnv, Authenticate)
modules/<m>/     <m>.module.ts, <m>.types.ts, router/<m>.router.ts, use-cases/<verb-noun>.ts,
                 repository/<m>.repository.ts (if it has tables), consumers/<m>.consumer.ts
```

Tests mirror it under `apps/api/test/` (`bootstrap/`, `middleware/`, `modules/<m>/`, `infra/`);
shared helpers (`testApp`, `recordMetrics`, the Valkey/Postgres probes, `openDatabase`,
`testAuth`, `testUsers`, the memory fakes) are in `test/support/`. The modules are `health` and
`auth`. A module is `createXModule(deps): Module`, and `bootstrap/app.ts`
mounts every module's `routes`; routers translate a use case's result through `reply`, use cases
hold the logic.

Ports (127.0.0.1): API 4600, Postgres 4632,
Valkey 4679, OTLP/gRPC 4617, OTLP/HTTP 4618, Grafana 4630, Prometheus 4690, Loki 4610, Tempo 4620.

## Rules

- **Nothing runs on import.** Files export factories; `bootstrap/container.ts` constructs
  everything and `main.ts` alone starts the process (`Bun.serve`, `handleSignals`). Only
  `container.ts` imports InferDI. `apps/api/test/structure.test.ts` enforces these and the syntax
  rules below.
- **Modules are closed.** A module folder holds only the role files in the layout above; modules
  never import each other (alias or relative); only `src/bootstrap/**` imports from
  `src/modules/**`; a router never imports its repository (it calls use cases); nothing under
  `modules/` builds a raw response (`x.json(`, `.text(`, `.html(`, `.body(`, `.newResponse(`, `new Response(`; reading a request, `c.req.json(`, is fine): use `reply`/`respond`.
  Shared code goes in `shared/`, `middleware/` or `infra/`. The structure test enforces all of it.
- **Exported signatures use named types.** The parameters and return type of an exported function
  or public method are never an object literal (`{ ... }`): name them (`<Thing>Options`,
  `<Thing>Deps`, `<Thing>Result`) where they are read (next rule). Primitives, named, generic and
  utility types, and destructuring (`({ a }: Opts)`) are fine; local helpers may be inline. An
  object literal nested in a generic (`Record<string, { ... }>`, `Promise<{ ... }>`) is flagged too.
- **A type lives where it is read.** A type only one file uses is declared in that file, unexported
  (`ValkeyOptions` in `infra/valkey.ts`). A type two or more files use goes in the folder's
  `types.ts`, and a `types.ts` holds one topic: `bootstrap/`, `shared/http/`, a module's
  `<m>.types.ts` and `packages/db` each keep a single file for their related types. Unrelated types
  never share a file. `packages/lib` and `packages/contracts` are libraries with no `types.ts`:
  each module declares and exports the types it offers (`RetryOptions` in `retry.ts`, the problem
  shape inferred beside its schema), and a lib module imports another's type from that module.
- **Exported types live in types files.** In `apps/api/src` and `packages/db`, every *exported*
  `interface` and `type` alias is declared in a `types.ts` (`<m>.types.ts`, `<area>.types.ts`); an
  unexported one stays in the file that uses it. Not covered: `packages/lib/src/**`,
  `packages/contracts/src/**` (libraries, above), and class-companion types
  (`export type X = InstanceType<typeof X>`, `v.InferOutput<typeof X>`), which stay beside their
  value. A module may re-export a moved type (`export type { X } from './types.ts'`) to keep its
  public import path. Derived types (`ReturnType<typeof f>`) go in `types.ts` through
  `import type`.
- **Define a thing once; derive the rest.** `duplicates.test.ts` enforces it (text heuristics, see
  its comment for the gaps):
  - A wire shape is a `@starter/contracts` schema and its inferred type (`export type X =
    v.InferOutput<typeof X>` beside the schema). A `types.ts` never redeclares its keys: use the
    type (`ReadinessStatus`, `ProblemView`), or `Pick`/`Omit` it. A module's `types.ts` holds only
    what contracts don't describe: deps, use-case inputs and results, internal state.
  - A set of values (a union, an `as const` tuple, a `picklist`) is written once. Write the tuple
    (a small import-free module such as `lib/observability.ts`, so config can read it without the
    SDK) and derive the type: `(typeof OTLP_PROTOCOLS)[number]`; `oneOfEnv(OTLP_PROTOCOLS, …)`. A
    map over the set is `Record<ThatType, …>` (`SEVERITY` over `LogLevel`), so the compiler keeps it
    whole; the text rule reads unions, tuples and picklists, not object keys. A setting's default
    lives beside its tuple (`DEFAULT_OBSERVABILITY_LEVEL`), and a lib `baseEnv` key an app
    overrides is deleted from `baseEnv`: the app owns it.
  - Two declarations never share three identical members. Put the shared ones in a base interface
    (`HttpDeps`, `RequestContext`) and `extend` it, or `extends Pick<Other, 'a' | 'b'>`.
  - `@starter/contracts` is a leaf: it imports only `valibot`, so `lib` (which takes `ProblemView`
    from it) can never form a cycle with it.
- **Owned rows go through `asUser`.** A table with a `user_id` of its own is created with
  `pgTable.withRLS(..., [ownerPolicy('<table>')])` and a migration that `FORCE`s row-level security;
  `packages/db/test/catalog.integration.test.ts` fails until both hold. Use cases reach it only
  through `asUser(database, { userId, signal, operation }, tx => ...)`; a repository takes that
  `Tx` (never `Db`, `BunSqlDatabase` or `asUser`) and filters by `userId` too (structure test).
  The API connects as `starter_api`, which is neither the owner nor BYPASSRLS; migrations run as
  the owner. better-auth's own tables (`user`, `session`, `account`, `verification`) carry no RLS.
- **Request input is validated by middleware.** A route takes `jsonBody(Contract)` or
  `queryParams(Contract)` and reads `c.req.valid(...)`; inputs that carry a secret (a verifier, a
  code) pass `{ redact: true }`. Put `signedIn` first on routes that need a session, so a
  signed-out caller hears 401 before anything about its body.
- **`shared/` imports nothing above it.** Nothing under `src/shared/` imports `middleware/`,
  `bootstrap/`, `modules/` or `infra/`; the structure test enforces it.
- **Object schemas live in contracts and config.** `v.object`, `v.strictObject`, `v.looseObject`
  and `v.objectWithRest` appear only in `packages/contracts/src/**` and `bootstrap/config.ts`; a
  route's query or body schema is a contract export (`*Query`, with a sample in `samples/`). The
  structure test enforces both rules (it is a text heuristic: see its comment for the gaps).
- **Everything with a lifetime is a `Resource`** (`@starter/lib`: `name`, optional `start`,
  `drain`, `check`, and `Symbol.asyncDispose`) added to a `ResourceStack` in startup order. Drain
  and disposal run in reverse and keep going past a failure. Constructors are sync and
  side-effect free; connecting happens in `start`. Build with closures: `createX(options): X`, where `X` is a
  named type (interface or type alias) and private state lives in the closure. `new SQL(...)` and
  `new RedisClient(...)` are lazy, so `BunSqlDatabase` and `Valkey` are still built without connecting.
  `Telemetry` is the one lifetime outside the `ResourceStack`: the logger needs its log provider
  before the stack exists and it is disposed after the stack, so the container calls its `start()`.
- **A class only for** a Resource (it owns a lifetime: implements `Resource` / `AsyncDisposable`,
  or is the process `Lifecycle`), the `CircuitBreaker` and `Singleflight`, and
  `Error` subclasses (`instanceof` and stack traces need them). Today: `Lifecycle`, `ResourceStack`,
  `BunSqlDatabase`, `Valkey`, `RuntimeMetrics`, `Telemetry`,
  `CircuitBreaker`, `Singleflight`, `AppError`, `CircuitOpenError`, `Rollback`. Everything else (`ExportFailureWarner`,
  use cases, mappers, route handlers) is a closure or a plain function;
  `structure.test.ts` fails a `class` outside its one allowed list. Classes use `#private` fields,
  and a test fakes one with `Pick<Class, 'method'>`, since `#` fields make the full type nominal.
- **Standard JS only** (the code must run unchanged under type stripping): `#private` fields and
  methods, no TS `private`, no `enum`, no `namespace`, no parameter properties. Use `as const`
  objects or unions. `tsconfig.base.json` sets `erasableSyntaxOnly`.
- **Inside `apps/api`, own-file imports are `#src/...ts`** (the `imports` of its package.json),
  never `../`. The `.ts` extension is part of the specifier (trap 14).
- **One error funnel.** Deliberate failures are classes from `@starter/lib/errors`; services return
  `Result`s, and `middleware/error-handler.ts` renders them as problem+json. `throw` is for bugs and
  infrastructure failing.
- **Tunables are config, never a constant in code.** A timeout, TTL, limit, size or rate someone
  might tune per deployment is an `Env` key with its default in `bootstrap/config.ts` (and a line
  in `.env.example`), passed in through options or deps: no `const X_TIMEOUT_MS = 500` in a
  container, a use case or a lib. Constants are for what is not a choice: protocol values (499),
  unit conversions, key namespaces, regexes. Tests read defaults from `test/support/env.ts`
  (`defaults`), not by repeating the number.
- **Timeouts are ordered.** Startup asserts `PRE_STOP_DELAY_MS + DRAIN_TIMEOUT_MS +
  DB_CLOSE_TIMEOUT_S * 1000 < SHUTDOWN_TIMEOUT_MS`, and that a request's own waits
  (`HEALTH_CHECK_TIMEOUT_MS`, `RATE_LIMIT_TIMEOUT_MS`) fit inside `REQUEST_TIMEOUT_MS`. Every await
  on I/O takes an `AbortSignal`.
- **Comments say why, briefly.**
- **One code style:** tabs, single quotes, 100 columns (`.oxfmtrc.json`).
- **`docs/`, `.superpowers/`, `bench/`, `*.plan.md` and `.env` stay out of git** (they are in `.gitignore`).
  Never `git add -A` blindly or `git add -f` them; the README must stand alone and not link to docs/.
- **Docker: only the compose project `starter`.** Other projects run on this machine
  (akashic-prod, old-country-local, postgres-9aff4cf4); never stop, restart, exec into or `down`
  any container whose name does not start with `starter`. Throwaway probes use `docker run --rm`.

## Testing

`bun run test`. Unit tests use in-memory fakes; each fake that stands for a real adapter should
run the same contract test as the adapter. Integration tests (`*.integration.test.ts`) run
against the compose Postgres and Valkey and each skips when nothing answers (or the schema is not
migrated), so `bun run check` passes without compose; with compose up and `bun run db:migrate`
nothing should be skipped except the Docker-gated tests. Tests connect as the owner
(`DATABASE_MIGRATION_URL`, default `postgres@127.0.0.1:4632`) to set up and clean up, and as the
API's role (`DATABASE_URL`, `starter_api`) where row-level security must apply; Valkey is
`VALKEY_URL` (default `127.0.0.1:4679`). The Docker-gated tests stop and start containers, so they
run only with `STARTER_DOCKER_TESTS=1` (the Valkey one uses the container named by
`STARTER_VALKEY_CONTAINER`, default `starter-valkey-1`). A test that writes to the database does
it inside `withRollback` (`@starter/db/testing`) so nothing persists; tests that go through
better-auth (which writes on its own pool) take addresses from `testUsers` and clean up after
themselves, including a deleted user's audit rows. Race tests commit uniquely named rows and delete
exactly those.

## Traps already hit

(Numbers follow akashic-records where the trap is the same; this list is its own.)

1. **Drizzle on bun:sql expands a JS array into a parameter list**, `($1, $2)::text[]`, a row cast
   Postgres refuses. Bind arrays with `pgArray()` from `@starter/db/sql`.
2. **Backslashes don't survive this shell's heredocs.** Write regex-bearing files with an editor
   tool, not `cat <<EOF`.
3. **Bun SQL queries are lazy thenables**: not sent until awaited, and `expect(query).rejects`
   hangs. Wrap it in `Promise.resolve(query)`.
4. **OTel ignores a second global registration in one process.** Tests use `recordSpans()` from
   `@starter/lib/testing`, which registers once; reset it in `beforeEach`.
5. **Hono drops headers set with `c.header` when a bare `new Response` is returned.** Problem
   responses use `c.newResponse`.
6. **There is no request scope.** Per-request values are on `c.var` and go to services as
   arguments.
7. **The OpenTelemetry SDK accepts one minor of `@opentelemetry/api`** (SDK 3: `>=1.10.0
   <1.11.0`), and Bun was not observed to warn on a mismatch. Every package pins the API with `~`, and moves
   it only with the SDK.
8. **Bun SQL cancel works.** Aborting `run()` calls `query.cancel()` and the backend leaves
   `active` in about 3 ms. The raw cancel rejects with errno `57014`; `run()` replaces it with the
   signal's reason. Bun's `Query` exposes no SQL text, so `run` takes an explicit operation name
   for spans and metrics.
9. **`LISTEN`/`NOTIFY` works** through `sql.listen(channel, cb)` and `sql.notify`.
10. **A transaction-local setting resets to `''` (not NULL) afterwards** on the same backend. `SET
    LOCAL` takes no bind parameters, so set it with ``select set_config('app.user_id', ${id}, true)``
    (a bound parameter, transaction-local); never interpolate a user value into `sql.raw`. Row-level
    security reads `current_setting('app.user_id', true)` and must treat `''` as unset.
11. **A subscribed Valkey client throws synchronously on ordinary commands**
    (`ERR_REDIS_INVALID_STATE`), not a rejected promise. The subscriber needs its own connection
    (`command.duplicate()`), and tests use `expect(() => ...).toThrow`.
12. **Valkey reconnect behaviour.** `connect()` to a refused port with `autoReconnect: true` stays
    pending (up to 20 retries), so `start` bounds it with its own deadline. A command queued while
    the server is down is sent after reconnect and resolves; one already on the wire (BLPOP)
    rejects with "Connection closed" and is not retried. Recovery after the server returns takes
    about 0.7 s. A `PING` health check queues while down, so it carries a 1 s timeout.
13. **`EVALSHA` works** through `send('EVALSHA', [sha, '1', key, ...])` after
    `send('SCRIPT', ['LOAD', ...])`.
14. **`rewriteRelativeImportExtensions` must be `false` in `apps/api/tsconfig.json`.** The base
    config enables it and tsc then raises TS2877 on `#src/*.ts` imports. Package `imports`
    targets are taken literally (`#src/x.ts` works, `#src/x` finds nothing); nothing is emitted,
    so the override costs nothing.
15. **`scheduler.yield` does not exist on Bun 1.4.4** (`typeof scheduler` is `undefined`). Yield
    with `await Bun.sleep(0)` or `setImmediate`.
16. **`heapStats()` from `bun:jsc` has no GC fields** (no pause time, no collection counts): only
    `heapSize`, `heapCapacity`, `extraMemorySize`, object counts and `mimalloc`. Dashboards show
    heap size and capacity, not GC.
17. **`process.constrainedMemory()` reports the cgroup limit, and the host RAM without one.**
    Observed on Bun 1.4.4: `docker run --rm --memory=256m oven/bun:1.4.4 bun -e
    'console.log(process.constrainedMemory())'` prints `268435456`; the same without `--memory`
    prints `16030089216`, equal to the host's value outside any container. A value near host RAM
    means "no limit", not "a 16 GB limit".
18. **`AsyncDisposableStack` works on Bun 1.4.4** (`ResourceStack` is built on it); no polyfill.
19. **protobufjs's postinstall is blocked on purpose** (it is not in `trustedDependencies`); the
    OTLP exporters work without it. Do not add it to silence the install notice.
20. **Latency histograms need second-scale buckets.** The default OTel buckets are millisecond-scale
    and made every request land in one bucket, so quantiles were meaningless. `LATENCY_BUCKETS_S`
    sets them explicitly.
21. **Request duration has one recorder.** `@hono/otel` is given a no-op meter so only our
    middleware records `http.server.request.duration`; two recorders double-count in Grafana.
22. **`/healthz` and `/readyz` are untraced** (probe noise), so check Tempo with another route.
    Readiness needs both Postgres and Valkey.
23. **OTLP over gRPC works on Bun 1.4.4** (`@opentelemetry/exporter-*-otlp-grpc`, which use
    `@grpc/grpc-js`): all three signals reached Prometheus, Tempo and Loki, and a closed port fails
    fast (disposal took ~50 ms against the 1 s bound; `http/protobuf` against a closed port waits out
    the bound). `OTEL_EXPORTER_OTLP_PROTOCOL` is `grpc` (4617), `http/protobuf` or `http/json`
    (4618); the endpoint is the bare address and only the HTTP flavours add `/v1/<signal>`. The SDK
    reports a failed export only through its diag logger (off by default), so an `ExportFailureWarner`
    (one per `Telemetry`, not a module global; `createExportFailureWarner`) warns once a minute itself. `Telemetry.start()`
    registers the global providers, so a test that starts one runs in a child process
    (`packages/lib/test/support/dead-endpoint.ts`), never in the shared one; constructing one
    registers nothing.
24. **Spans never set `SpanStatusCode.OK`.** On success the status stays UNSET (OK is for an
    operator overriding an error, per the OTel spec). `traced` owns the span lifecycle, including a
    returned `err`, a throw and cancellation; `withConsumerSpan` delegates to it. `currentTraceparent`
    goes through `propagation.inject`, so an invalid span (telemetry off) yields no header, not an
    all-zero one. `isAbortError` and `isTimeout` (`@starter/lib/abort`) accept a `DOMException` or
    a plain `Error` with that name: libraries throw the plain kind.
25. **better-auth 1.7.18 (`apps/api/test/infra/better-auth.traps.integration.test.ts` pins these; the exceptions are labelled "not pinned").**
    The adapter is `drizzleAdapter(db, { provider: 'pg', schema: { user, session, account, verification } })`
    with the four tables by key: no `usePlural` or field mapping is needed for the snake_case
    columns. Imports are `better-auth/adapters/drizzle` and `better-auth/plugins/bearer`.
26. **Without `advanced.database.generateId` better-auth makes 32-character ids** and Postgres
    refuses them for a `uuid` column (`22P02`, surfaced as a 422 `FAILED_TO_CREATE_USER`). Set
    `generateId: () => Bun.randomUUIDv7()`; it applies to every table.
27. **`Bun.password` (argon2id) works as the `password.hash`/`verify` override** (stored value starts
    `$argon2id$`) and runs off the JS thread: a 5 ms interval kept ticking during a hash.
28. **`api.*` calls throw `APIError`** with `statusCode` (number), `status` (a name such as
    `'UNAUTHORIZED'`) and `body: { message, code }`. Observed codes: `EMAIL_PASSWORD_SIGN_UP_DISABLED`
    (400, `disableSignUp`), `EMAIL_NOT_VERIFIED` (403), `INVALID_EMAIL_OR_PASSWORD` (401),
    `FAILED_TO_CREATE_USER` (422).
29. **Bearer.** `signInEmail({ asResponse: true })` carries a `set-auth-token` header and a `token`
    in the JSON body (`{ redirect, token, user }`), plus a `better-auth.session_token` `set-cookie`. The
    header value is the signed token `<token>.<signature>`, the body's is the raw session token (the
    header is what the server hands out for bearer use). `getSession` accepts BOTH
    `Authorization: Bearer <signed set-auth-token value>` and `Bearer <raw body token>` (both return
    the session; pinned). Give native clients the signed header value. `revokeSessions` kills every session of the user, so all their
    tokens then give `null`.
30. **Verification mail.** `sendVerificationEmail({ url, token })` is not awaited by sign-up (poll
    briefly in a test). The url is `<baseURL>/auth/verify-email?token=<jwt>&callbackURL=%2F`;
    through `auth.handler(new Request(url))` it answers 302 and sets `email_verified`; it does not
    sign the user in.
31. **A duplicate sign-up with `requireEmailVerification` answers 200 with a fabricated user**
    (`token: null`, a new random id, nothing stored): no account enumeration, but the response id is
    not the stored one.
32. **`signInSocial` needs no network for the authorization URL.** With `disableRedirect: true` it
    returns `{ url, redirect: false }` (`accounts.google.com/o/oauth2/v2/auth`, `code_challenge`
    with `S256`, `state`, `redirect_uri` `<baseURL>/auth/callback/google`) and `set-cookie:
    better-auth.state=...; Max-Age=300; HttpOnly; SameSite=Lax`. `disableImplicitSignUp` is in the
    Google provider's types.
33. **Deleting a user.** Deleting the `user` row directly (as the owner) cascades `session`,
    `account` and `user_settings` by FK: that is pinned. `api.deleteUser` (`user.deleteUser.enabled`)
    needs the session and `body.password`, calls `beforeDelete` once, and leaves none of those rows;
    whether better-auth removes sessions/accounts itself before the user row is observed-not-pinned
    (only the end state is asserted), so rely on the FK cascade only for `user_settings` and any
    table we add.
34. **Closed sign-up must be set twice on Google.** better-auth's callback computes
    `disableSignUp: provider.disableImplicitSignUp && !requestSignUp || provider.options?.disableSignUp`
    (`dist/api/routes/callback.mjs:142`), so a client sending `requestSignUp: true` to `signInSocial`
    creates a user despite `disableImplicitSignUp`. Set `disableSignUp` on the provider as well.
35. **`databaseHooks.user.create.after` runs after the user row is written.** A throwing hook fails
    the request but leaves the user, so `user_settings` can be missing: reads create it lazily.
36. **better-auth reads the client address from `x-forwarded-for`**, and with no trusted proxies it
    takes a single value from any client: a new value per request is a new rate-limit bucket and
    the address recorded on the session. The auth router sets `x-starter-client-address` from the
    socket (`withClientAddress`, overwriting any client value) and better-auth reads only that
    (`advanced.ipAddress.ipAddressHeaders`). Its limiter answers 429 with `X-Retry-After`, which
    the router turns into `Retry-After`. `sign-in-limit.test.ts` pins both.
37. **better-auth 1.7 rate-limit storage is one atomic `consume(key, { window, max })`**
    (`customStorage`); the separate get/set shape is gone. `infra/rate-limit.ts` implements it as a
    Lua token bucket on Valkey's clock and fails open after 500 ms.
38. **InferDI `override` refuses a `registerValue` key** (`clock`, `env`): values are cached when
    registered, so it throws "already been resolved". `buildContainer(env, clock)` takes the clock as
    a parameter.
