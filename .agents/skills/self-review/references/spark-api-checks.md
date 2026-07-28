# spark-api review checklist

The backend rule set, highest-value first. Each item: **what to look for** in the
diff, **why it bites** (the trap behind it), and the **severity** it maps to (see
`report-template.md`). These mirror spark-api's `AGENTS.md` "Code Review Rules" and
"Non-obvious rules a contributor MUST know" — read that file too; where it differs
from this list, it wins.

Ground truth for this repo: **TS strictness is OFF** (`strictNullChecks: false`,
`any` tolerated), so a declared or inferred type can lie. Trust the class-validator
DTO for the request contract and the actual serialized entity for the response
contract — not the TS.

## 1. DTOs are classes with class-validator decorators — high

A request DTO must be a **class** with `@IsString`/`@IsEnum`/`@IsUUID`/
`@IsOptional`/`@ValidateNested`/… decorators — not a bare `interface` or `type`.
The decorators, not the TS type, are the authoritative request contract; an
interface validates nothing at runtime.

- Look for: new/edited files under `dto/`, `@Body()`/`@Query()`/`@Param()`
  parameters typed by an `interface`, or a DTO class with fields that carry no
  validation decorator.
- Trap: the global `ValidationPipe` has **no `transform` and no `whitelist`**
  (main.ts sets only `forbidUnknownValues: false` + a custom `exceptionFactory`).
  So: `@Query`/`@Param` arrive as **strings** (`page: number` is a string at
  runtime — must be coerced), nested `@Type()` transforms do **not** run, and
  unknown properties are **not** stripped. Don't assume an incoming body is a
  class instance.
- Severity: undecorated field on a write path → high (bad data accepted);
  string-not-coerced numeric/boolean query → medium unless it drives a
  branch/query, then high.

## 2. `synchronize: true` schema changes — blocker/high

There are **no migrations**; `synchronize: true` runs in production. Any
`@Column`/entity edit mutates the **live schema on next deploy**.

- Look for: added/removed/renamed `@Column`, type changes, `nullable`
  changes, new/removed entities or relations under `entity/`.
- Trap: a column **rename or drop is destructive** — the old column's data is
  gone with no migration safety net. Type-narrowing can fail on existing rows.
- Ask: is this rename/drop intentional, and is there a `scripts/*.sql` or dated
  `onetime/*` backfill for the data? A nullability change also changes the
  **response** contract (a now-nullable column is a nullable response field →
  route to `api-contract-check`).
- Severity: destructive rename/drop/type-narrow with data at risk → **blocker**;
  additive column or nullability shift → high (and a contract-check trigger).

## 3. New controllers need `@UseInterceptors(ResponseInterceptor)` — high

The `{ data: T }` response envelope is **opt-in per controller**, not global
(~55 of ~62 controllers have it; `libs/interceptors/`). A controller **without**
the decorator returns a **bare** payload, which breaks spark-web's
envelope-unwrapping (it expects `res.data.data`).

- Look for: a new `*.controller.ts`, or a new class-level decorator block, with
  no `@UseInterceptors(ResponseInterceptor)`.
- Note: this is intentionally per-controller — if a route is deliberately bare
  (e.g. a webhook, a health check), that's fine, but the FE type must then be
  `T`, not `{ data: T }`. Flag the mismatch, not the choice.
- Severity: missing envelope on a controller the FE consumes → high.

## 4. No leaked entity fields / no serialization safety net — blocker/high

There is **no `ClassSerializerInterceptor`** and **no `@Exclude`/`@Expose`**
anywhere. Whatever object a service returns is JSON-serialized **in full** —
every column of a returned entity is on the wire.

- Look for: a service/controller returning a raw entity that has sensitive or
  internal columns (password/hash, tokens, secrets, other users' PII, internal
  flags). Omission must happen **in the service/query** (select specific
  columns, map to a shape) — you cannot rely on a decorator.
- Severity: a returned entity leaking a credential/secret column → **blocker**;
  leaking internal-but-not-secret fields → high.

## 5. New routes are guarded — high

There is **no global `APP_GUARD`**. Guards (`AuthenticationGuard`,
`AuthorizationGuard`, `ApiKeyAuthGuard`) are applied **per-route via
`@UseGuards(...)`**. A new route is **public unless guarded**.

- Look for: a new `@Get/@Post/@Patch/@Delete` handler (or a new controller) with
  no `@UseGuards` at method or class level.
- Ask: is this route intentionally public (webhook, SSO callback, health)? If
  not, it's an unauthenticated endpoint.
- Severity: unintentionally public route exposing data or a mutation → high
  (blocker if it exposes/writes sensitive data).

## 6. API contract in sync with spark-web — route to api-contract-check

spark-web's request/response types are **hand-written, no codegen** and drift
silently. Any change to a DTO, a route, or a serialized entity should be checked
against spark-web.

- Look for: any diff hunk under `dto/`, `controller/`, or an `entity/` a route
  serializes.
- Action: **recommend the `api-contract-check` skill** with the touched
  endpoint(s) as scope — do not re-diff types here. When spark-web isn't checked
  out, `api-contract-check` degrades to single-repo self-consistency — and from
  the backend alone that's limited (it can't see the hand-written FE mirror), so
  flag the drift risk anyway; never claim "aligned" from the backend side alone.

## 7. Hygiene — medium/blocker

- **No leftover `console.log`** / debug statements in committed code — medium.
- **No committed secrets** — no keys, tokens, `.env`, service-account JSON. Any
  added secret is a **blocker** (and never print its value). The repo already
  has a committed GCP service-account key problem; don't add another.
- **Removing a tracked secret is the right fix but rarely complete.** Untracking
  or deleting a committed key/`.env` stops *future* tracking, but the value
  remains in git history and live until rotated. Treat a secret-removal diff as a
  **merge** (it's the prescribed remediation, not a new leak) with a **low
  follow-up**: rotate the credential and purge history separately. Don't block
  the cleanup PR; don't mistake the removal for a completed fix.
