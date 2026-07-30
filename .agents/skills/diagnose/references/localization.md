# Localization

How to get from a symptom to the file that owns it. Name the files before
theorizing about them — a hypothesis about code you haven't opened is a guess.

## Reading a screenshot

Extract, in this order:

1. **The route** — from the URL bar if visible, otherwise from recognizable nav or
   page chrome. This is the highest-value clue; it maps directly to a page folder.
2. **The failing region** — which panel, table, or field is wrong, and *how*:
   **blank/absent** (class A), **stale** (class B), **wrong value** (class E), or
   **visually broken** (class I). These lead to different candidate lists.
3. **Any toast or error text** — a Mantine toast usually means
   `handleMutationError` fired from an `ApiError`, which means the request
   *reached* the backend and came back non-2xx. That alone rules out most of
   class A.
4. **Visible devtools** — if the Network or Console panel is in the shot, read it
   before anything else; it often settles the diagnosis outright.
5. **Empty vs zero vs dash** — an empty string, a literal `0`, `undefined`
   rendered blank, and a placeholder dash are different bugs. Distinguish them.

If the screenshot leaves two or more candidates equally live, **ask for the
Network tab** (request URL, status, raw response body) or the console. One
specific ask, not a questionnaire.

## spark-web traversal

```
URL / route
  └─ src/routing/            react-router v6 router, route guards, RoutePaths const
       └─ src/pages/<feature>/        ~23 feature page folders
            └─ src/components/<feature>/   ~25 feature folders (+ core/ layout/ navigation/ agent/)
                 └─ src/api/<resource>.ts   the hook: useQuery + useMutations
                      ├─ src/api/const.ts   QueryKey + Endpoint maps
                      ├─ src/api/config.ts  axiosClient, auth interceptor, envelope types
                      └─ src/api/util.ts    handleMutationError
       └─ src/store/          Zustand (auth, course, nav) — check when data is stale
                              but the query looks right
       └─ src/theme.ts        colors/scales; getGradeColor(); AgentPurple
```

Notes:

- One module per resource; **singular file = entity type, plural = list hook**.
- Some `src/api/*` files are `.tsx` because they export React context/providers
  (`auth.tsx`, `course.tsx`) — don't assume `.ts` when grepping.
- Path alias is `@/* → src/*` in both tsconfig and `vite.config.ts`.
- Auth tokens live in `localStorage` via the persisted `useAuthStore`
  (`auth-store` key); auth is Cognito-backed but brokered through the backend
  (`/users/login`, `/sso/*`, `/users/refresh`) with no Amplify in the browser.

## spark-api traversal

```
Endpoint path (from Endpoint map or the network capture)
  └─ src/<feature>/<feature>.module.ts        what's wired, incl. SQS consumers
       └─ controller/<name>.controller.ts     route decorators, @UseGuards,
       │                                      @UseInterceptors(ResponseInterceptor)
       ├─ dto/<name>.dto.ts                   class-validator classes = request contract
       ├─ service/<name>.service.ts           the query; what it selects IS the response
       ├─ entity/<name>.entity.ts             TypeORM entity = the LIVE schema
       └─ consumer/ strategy/ guard/ gateway/ event/   (larger modules)

src/config/config.service.ts                   TypeORM setup: synchronize,
                                               SnakeNamingStrategy
src/main.ts                                    global ValidationPipe (no transform,
                                               no whitelist — see symptom class F)

libs/  (aliases)
  @app/auth           Cognito + LTI via one Passport JWT strategy (branches on iss);
                      AuthenticationGuard, AuthorizationGuard, ApiKeyAuthGuard
  @app/interceptors   ResponseInterceptor  ({ data: T } envelope — opt-in per controller)
  @app/messaging      SQS
  @app/cache          Redis (ioredis)
```

Notes:

- **The entity is the response contract**, because there is no serializer. Read
  what the *service* returns, then read the entity for every column that ships.
- **The DTO is the request contract**, not the TS type — strictness is off.
- `app.module.ts` registers the SQS consumers; start there for async symptoms.
- **`src/config/config.service.ts`** holds the TypeORM setup — `synchronize` and
  `SnakeNamingStrategy` both live there. Read it when a symptom smells like schema
  or casing rather than assuming from an entity alone.
- Design docs in `docs/` are worth reading for domain bugs — note the filenames are
  longer than the topic: `grading-pipeline.md`, `credit-reservation-system.md`,
  `regrade-request-system.md`, plus per-integration Canvas/Brightspace notes and
  `duplicate-account-troubleshooting.md`.

## Async / SQS paths

Heavy work — grading, PDF→image, scanning, insights, regrade — is enqueued and
consumed out-of-band, so a UI symptom can be several hops from the failure:

```
UI action → controller → service → SQS enqueue
                                     └─ consumer/ (registered in app.module.ts)
                                          └─ src/grading/service/grading-pipeline.service.ts
                                               ├─ consensus.service.ts
                                               └─ strategy/  digital-submission
                                                             discussion-forum
                                                             handwritten-paper
                                                             oral-examination
```

These need AWS creds and live queues — **they do not run locally without them**.
Establish that before reading code for a bug that may not exist. LLM provider
clients live in `src/llm/lib/` orchestrated by `service/llm.service.ts`; refer to
the config/service value that selects a model, never a hardcoded model ID.

## Crossing the repo boundary

When the symptom is FE but the cause may be BE, cross at the **endpoint**: get the
concrete path from the network capture (or the `Endpoint` map), then find the
controller that owns it. Confirm the envelope (`ResponseInterceptor` present?) and
the shape (service return + entity) before concluding drift — and once drift *is*
the established cause, hand the endpoint to **`api-contract-check`** rather than
diffing every field here.

With only one repo checked out, say which side you could not read and scope the
conclusion to what you verified. Never assert a cross-repo root cause from one
side.

## Tests and reproduction

- **spark-web has no tests at all** — no framework, no runner. There is no
  standalone typecheck script either; typechecking happens inside
  `pnpm build` (`tsc -b`). Reproduction is manual, in the browser.
- **spark-api has jest** but only ~5 `*.spec.ts` files exist, so there's rarely an
  existing test to lean on. Tests run against a **real** Postgres
  (`TEST_DATABASE_URL`, `dropSchema: true`) — app DB on host port 5452, test DB on
  5453 via `docker-compose.yml`. `pnpm test:debug` is **broken** (a typo in
  `package.json`); don't reach for it.
- App boot requires `DATABASE_URL` or it throws.

Given how little test coverage exists, prefer a **targeted manual reproduction**
plus code evidence over trying to write a failing test — and say so rather than
implying a test proved the cause.
