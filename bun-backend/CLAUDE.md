# Starter

A Bun monorepo boilerplate for a production API: Bun 1.4, Hono, Valibot, Drizzle 1.0 rc,
Postgres 18, Valkey 8, InferDI, OpenTelemetry. `apps/api` is the HTTP shell (config, lifecycle,
health, telemetry); `packages/{lib,db,contracts}` are the shared code. There are no domain
features: add them as modules under `apps/api/src/modules/`.

Bun is usually off PATH here: `export PATH="$HOME/.bun/bin:$PATH"`.

## Commands (from the repository root)

```
docker compose -f deploy/compose.yaml up -d --wait   Postgres, Valkey and the Grafana stack (project starter)
docker compose -f deploy/compose.yaml down           stop it (add -v to drop the volumes)
bun run dev            API with reload; reads ./.env (cp .env.example .env), port 4600
bun run check          format:check, lint, typecheck, test: what CI runs
bun run format         oxfmt apps packages
```

## Layout (`apps/api/src`)

```
main.ts          entry only
bootstrap/       config.ts, container.ts, runtime.ts, app.ts, types.ts (Module, Started, option types)
middleware/      request-context.ts, error-handler.ts, security.ts
infra/           valkey.ts, runtime-metrics.ts
shared/http/     reply.ts, problem.ts, types.ts (HttpDeps, RequestContext, AppEnv)
modules/<m>/     <m>.module.ts, <m>.types.ts, router/<m>.router.ts, use-cases/<verb-noun>.ts,
                 repository/<m>.repository.ts (if it has tables), consumers/<m>.consumer.ts
```

Tests mirror it under `apps/api/test/` (`bootstrap/`, `middleware/`, `modules/<m>/`, `infra/`);
shared helpers (`testApp`, `recordMetrics`, the Valkey/Postgres probes) are in `test/support/`.
`health` is the first module. A module is `createXModule(deps): Module`, and `bootstrap/app.ts`
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
  unexported one stays in the file that uses it. Not covered: `packages/lib/src/**` and
  `packages/contracts/src/**` (above), and class-companion types
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
    SDK) and derive the type: `(typeof OTLP_PROTOCOLS)[number]`; `oneOfEnv(OTLP_PROTOCOLS, …)`.
  - Two declarations never share three identical members. Put the shared ones in a base interface
    (`HttpDeps`, `RequestContext`) and `extend` it, or `extends Pick<Other, 'a' | 'b'>`.
  - `@starter/contracts` is a leaf: it imports only `valibot`, so `lib` (which takes `ProblemView`
    from it) can never form a cycle with it.
- **`shared/` imports nothing above it.** Nothing under `src/shared/` imports `middleware/`,
  `bootstrap/`, `modules/` or `infra/`; the structure test enforces it.
- **Object schemas live in contracts and config.** `v.object`, `v.strictObject`, `v.looseObject`
  and `v.objectWithRest` appear only in `packages/contracts/src/**` and `bootstrap/config.ts`; a
  route's query or body schema is a contract export (`*Query`, with a sample in `samples/`). The
  structure test enforces both rules (it is a text heuristic: see its comment for the gaps).
- **Everything with a lifetime is a `Resource`** (`@starter/lib`: `name`, optional `start`,
  `drain`, `check`, and `Symbol.asyncDispose`) added to a `ResourceStack` in startup order. Drain
  and disposal run in reverse and keep going past a failure. Constructors are sync and
  side-effect free; connecting happens in `start`, reached through a static async factory.
- **Standard JS only** (the code must run unchanged under type stripping): `#private` fields and
  methods, no TS `private`, no `enum`, no `namespace`, no parameter properties. Use `as const`
  objects or unions. `tsconfig.base.json` sets `erasableSyntaxOnly`.
- **Inside `apps/api`, own-file imports are `#src/...ts`** (the `imports` of its package.json),
  never `../`. The `.ts` extension is part of the specifier (trap 14).
- **One error funnel.** Deliberate failures are classes from `@starter/lib/errors`; services return
  `Result`s, and `middleware/error-handler.ts` renders them as problem+json. `throw` is for bugs and
  infrastructure failing.
- **Timeouts are config, and ordered.** Startup asserts `PRE_STOP_DELAY_MS + DRAIN_TIMEOUT_MS +
  DB_CLOSE_TIMEOUT_S * 1000 < SHUTDOWN_TIMEOUT_MS`. Every await on I/O takes an `AbortSignal`.
- **Comments say why, briefly.**
- **One code style:** tabs, single quotes, 100 columns (`.oxfmtrc.json`).
- **`docs/`, `.superpowers/`, `*.plan.md` and `.env` stay out of git** (they are in `.gitignore`).
  Never `git add -A` blindly or `git add -f` them; the README must stand alone and not link to docs/.
- **Docker: only the compose project `starter`.** Other projects run on this machine
  (akashic-prod, old-country-local, postgres-9aff4cf4); never stop, restart, exec into or `down`
  any container whose name does not start with `starter`. Throwaway probes use `docker run --rm`.

## Testing

`bun run test`. Unit tests use in-memory fakes; each fake that stands for a real adapter should
run the same contract test as the adapter. Integration tests (`*.integration.test.ts`) run
against the compose Postgres (`DATABASE_URL`, default `127.0.0.1:4632`) and Valkey (`VALKEY_URL`,
default `127.0.0.1:4679`) and each skips when nothing answers, so `bun run check` passes without
compose; with compose up nothing should be skipped except the Docker-gated tests. Those stop and
start containers, so they run only with `STARTER_DOCKER_TESTS=1` (the Valkey one uses the
container named by `STARTER_VALKEY_CONTAINER`, default `starter-valkey-1`). A test that writes
to the database does it inside `withRollback` (`@starter/db/testing`) so nothing persists; race
tests that need several connections commit uniquely named rows and delete exactly those.

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
    reports a failed export only through its diag logger (off by default), so `createOtlpExporters`
    warns once a minute itself. `createTelemetry` registers global providers, so a test of it runs
    in a child process (`packages/lib/test/support/dead-endpoint.ts`), never in the shared one.
