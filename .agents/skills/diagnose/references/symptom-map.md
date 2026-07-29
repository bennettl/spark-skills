# Symptom map

Symptom classes → candidate causes, **ranked by how often this stack produces
them**. Each candidate: what to check, and what rules it out.

Ground truth this map is built on (from both repos' `AGENTS.md` — read those too;
where they differ, they win):

- **No runtime validation at the API boundary.** spark-web's types are hand-written
  with no codegen and no shared package; zod exists but never validates responses
  (`.parse`/`.safeParse` appear nowhere in `src/api`). Drift is silent.
- **The `{ data: T }` envelope is opt-in per controller** via
  `@UseInterceptors(ResponseInterceptor)`. Without it a controller returns a bare
  payload.
- **No serialization layer** in spark-api — no `ClassSerializerInterceptor`, no
  `@Exclude`/`@Expose`. A returned entity serializes every column.
- **Guards are per-route** (`@UseGuards`); there is no global `APP_GUARD`. New
  routes are public unless guarded.
- **`synchronize: true`, no migrations.** The entity *is* the live schema.
- **`ValidationPipe` has no `transform` and no `whitelist`.** `@Query`/`@Param`
  arrive as strings, nested `@Type()` doesn't run, unknown props aren't stripped.
- **TS strictness is off in spark-api**, on in spark-web.

---

## A. Blank / missing / `undefined` where data should be

The most common class, and the one with the most candidates that look identical.

1. **Envelope depth wrong** — axios wraps in `response.data`, backend wraps in
   `{ data }`. A single object is `res.data.data`; a nestjs-paginate list is
   `res.data.data.data` (array) + `res.data.data.meta`. *Check:* the unwrap
   expression at the `queryFn` call site against whether the route is paginated.
   *Ruled out by:* depth matching the route's actual shape in a network capture.
2. **Missing `ResponseInterceptor` on the controller** — returns a bare payload, so
   the FE's `.data.data` is `undefined`. *Check:* the controller class for
   `@UseInterceptors(ResponseInterceptor)`. Suspect this first when the endpoint is
   **new**. *Ruled out by:* the decorator being present on the controller.
3. **FE↔BE field drift** — a renamed, removed, or newly-nullable backend field.
   Compiles clean, renders blank. *Check:* the FE `interface` against the entity or
   DTO → then hand to **`api-contract-check`**. *Ruled out by:* field-for-field
   agreement on the touched shape.
4. **Query gated wrong or not at all** — an ungated `useQuery` fires with an
   `undefined` filter and returns empty or wrong data. *Check:* `enabled: !!…`
   against every id/filter the `queryFn` reads. *Ruled out by:* every dependency
   being non-null when the request fires.
5. **nestjs-paginate filter malformed** — list filtering uses `filter.<field>` with
   operators like `$in:a,b` and `limit` (often `limit: 1000` for "all"), not
   offset/page. A wrong param name silently returns everything or nothing.
   *Check:* the `params` object against the backend's paginate config.
6. **Service query omits the field** — because there's no serializer, what the
   service selects is what ships. A `select:` or relation not loaded returns
   `undefined`, not an error. *Check:* the service's query builder / `find` options
   for the missing field or un-joined relation.

## B. Stale data after an action

1. **Mutation didn't invalidate** — no `invalidateQueries` in `onSuccess`.
   *Check:* the mutation's `onSuccess`.
2. **Invalidated the wrong or only part of the key set** — list invalidated but not
   the detail just edited, or vice versa. *Check:* every `QueryKey` that renders the
   affected data, not just the obvious one.
3. **Key shape mismatch** — the query uses `[QueryKey.Xxx, { ...filters }]` but the
   invalidate call passes a different filter object, so it doesn't match.
   *Check:* the two key arrays side by side; partial prefix matching means the
   filter object must be compatible, not merely present.
4. **Optimistic/local state diverged** — a Zustand store holds a copy that wasn't
   updated alongside the cache. *Check:* whether the component reads the store or
   the query.

## C. 401, redirect to `/logout`, or an auth loop

1. **Silent-refresh path failed** — the axios request interceptor proactively
   refreshes when the token expires within 5 min via `POST /users/refresh`, and on
   failure redirects to `/logout`. A loop usually means refresh is failing, not
   that login is broken. *Check:* the refresh response in a network capture, and
   `src/api/config.ts`'s interceptor.
2. **Token `iss` branch** — one Passport JWT strategy branches on issuer:
   `spark-lti` → HMAC `LTI_JWT_SECRET`; otherwise Cognito → JWKS. An LTI token
   validated as Cognito (or the reverse) fails opaquely. *Check:* `libs/auth/`'s
   strategy and the token's `iss`.
3. **Route guard mismatch** — the FE assumes authenticated access to a route that
   is guarded differently (or the guard expects an api key). *Check:*
   `@UseGuards(...)` on the controller/route.
4. **Missing/expired `VITE_API_URL` target or CORS** — no dev proxy exists; the SPA
   calls the backend directly. *Check:* the request's origin and the backend's CORS
   config.

## D. Wrong tenant's data, or data that should be forbidden

Treat this class as **security-relevant** — report it as such, not as a plain bug.

1. **Route not guarded** — no global `APP_GUARD`, so an un-decorated route is
   public. *Check:* `@UseGuards` presence on the route and its controller.
2. **No ownership / course-scope check in the service** — the guard authenticates
   but doesn't authorize *this* record. *Check:* whether the service query filters
   by the caller's course/org, not just by the requested id.
3. **Leaked entity columns** — no serializer, so a returned entity ships every
   column including sensitive ones. *Check:* what the service actually returns vs
   what the entity declares.
4. **`courseId` passed as an HTTP header** on some endpoints rather than a form
   field — easy to omit or read from the wrong place. *Check:* the endpoint's
   expected location for it.

## E. Wrong number, date, or casing

1. **Postgres `numeric`/`bigint` serialize as strings** — arithmetic on them
   silently concatenates or yields `NaN`. *Check:* the column type in the entity vs
   the FE's `number` declaration.
2. **`timestamptz` serializes as an ISO string** — not a `Date`. *Check:* the FE's
   handling before formatting.
3. **`SnakeNamingStrategy`** maps camelCase entity fields to snake_case columns
   while API JSON stays camelCase. A raw query or a hand-built response can leak
   snake_case to the client. *Check:* raw SQL / query-builder `select` aliases.

## F. Validation error or 500 on write

1. **DTO is an interface, not a decorated class** — no validation runs at all, and
   bad input reaches the service. *Check:* the DTO is a `class` with
   class-validator decorators.
2. **`@Query`/`@Param` are strings** — the pipe has no `transform`, so a
   `page: number` is `"2"` at runtime. *Check:* explicit coercion before numeric
   use.
3. **Nested `@Type()` didn't run** — nested objects arrive as plain objects, so
   `@ValidateNested` sees the wrong thing. *Check:* nested DTO handling.
4. **Unknown properties pass through** — no `whitelist`, so extra fields reach the
   service and can land in an entity write. *Check:* what the service spreads into
   the entity.
5. **`FormData` / multipart mismatch** — uploads go as `multipart/form-data`.
   *Check:* content type and field names against the controller's interceptor.

## G. Column or data missing after a deploy

1. **`synchronize: true` mutated the live schema** — an entity edit ran on deploy;
   a rename is a **drop + add**, i.e. data loss. *Check:* recent entity diffs
   against the live column set. This is the first thing to suspect when data
   vanished without a code path that deletes it.
2. **Backfill never ran** — data changes go through `scripts/*.sql` or dated
   `onetime/*` scripts, executed manually via `pnpm execute`. *Check:* whether the
   accompanying script was actually run.

## H. Async work never happened

Grading, PDF→image, scanning, insights, and regrade run through **AWS SQS**
consumers registered in `app.module.ts`.

1. **No AWS creds/queues in this environment** — locally, these flows simply don't
   run. *Check:* environment before assuming a code bug.
2. **Wrong grading strategy for the submission type** — a strategy pattern in
   `src/grading/strategy/` (digital-submission, discussion-forum,
   handwritten-paper, oral-examination). *Check:* which strategy the submission
   resolves to.
3. **Credit reservation blocked it** — see `docs/credit-reservation.md`.
   *Check:* whether a reservation failed before the work was enqueued.
4. **Consumer threw and the message was retried/dropped** — *Check:* Sentry and the
   consumer's error handling.

## I. Component renders wrong (not blank)

1. **Mantine v7 vs v8 seam** — `@mantine/carousel` is on **v8** while the rest of
   Mantine is **v7**; APIs differ. *Check:* which package the component imports.
2. **Ad-hoc color instead of `theme.ts`** — named scales (`DarkPurple`, `Purple`,
   `AccentGreen`), the `AgentPurple` accent, and helpers like `getGradeColor()`
   live there. *Check:* hardcoded hex against the theme constant it should use.
3. **CSS module / PostCSS ordering** — styling is Mantine + `postcss-preset-mantine`
   + a few CSS modules under `src/styles/`. *Check:* specificity and import order.

---

## Cross-class notes

- **Several classes share candidates.** A blank panel can be envelope depth, drift,
  a missing interceptor, or an ungated query — all four look identical in a
  screenshot. This is exactly when to ask for the **Network tab**: the request URL,
  status, and raw response body separate all four in one look.
- **New endpoint ⇒ check the interceptor and the maps first.** The most common
  cause of "my new endpoint returns nothing" is a missing `ResponseInterceptor`
  (backend) or an endpoint not registered in `QueryKey`/`Endpoint` (frontend).
- **Bug reproduces only in production ⇒ suspect G and H first** (schema mutation
  on deploy, or SQS/AWS availability), since neither reproduces locally.
