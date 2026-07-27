---
name: api-contract-check
description: >-
  Detect drift between the spark-api backend contract (NestJS controllers, DTOs,
  serialized entities) and the spark-web frontend's hand-written API types + zod
  schemas. Use before merging any change that touches a request/response shape, a
  new or changed endpoint, or an api module under spark-web/src/api. Reports
  field-level mismatches (name, type, optionality, nullability, enum values,
  casing, date/number serialization, response envelope, pagination) with
  file:line on both sides and a minimal one-sided fix.
metadata:
  supaclass-repos: [spark-api, spark-web]
  maturity: vertical-slice
---

# api-contract-check

Supaclass keeps frontend API types **hand-written** to mirror the backend — there
is no shared type package and no codegen. That mirror drifts silently: a backend
field rename, a nullability change, or a new response envelope compiles fine on
both sides and only surfaces as a runtime bug. This skill compares the two
contracts field-by-field and reports where they've diverged.

## When this fires

Run it before merging a change that touches any of:
- a NestJS controller route, request DTO, or the entity a route serializes;
- an api module under `spark-web/src/api/`, its request/response types, or its zod schema;
- the `QueryKey` / `Endpoint` maps in `spark-web/src/api/const.ts`.

Skip it for changes with no wire-shape impact (pure styling, internal refactors
that don't alter a request or response). If unsure, run it — a false alarm costs
seconds; missed drift ships a bug.

## Inputs

- **Two repo roots.** Default to sibling checkouts: `../spark-api` and
  `../spark-web` relative to wherever the skill runs. Accept overrides if the
  caller names different paths.
- **A scope**, one of: an endpoint path (e.g. `POST /assignments/:id/grade`), a
  feature area, or "the changed files on this branch."
- **Degrade gracefully.** If only one repo is available, say so explicitly and
  fall back to single-repo self-consistency checks (DTO ↔ zod within a repo,
  Endpoint-map ↔ module coverage). Never fabricate the other side's contract.

## Method

1. **Locate the pair.**
   - FE: from `src/api/const.ts`, resolve the `Endpoint` entry (and its
     `QueryKey`) for the scope → open the api module that calls it → find its
     request type, response type, and any zod schema.
   - BE: find the NestJS controller route that matches that endpoint. **Compose
     `setGlobalPrefix` and any URI versioning** when matching the path, or the
     match silently fails and you wrongly report "no endpoint found." Capture the
     method signature, request DTO(s) from `@Body` / `@Query` / `@Param`, and the
     declared response type / serialized entity.
   - **Wrappers — resolve for the *specific* route.** Open `main.ts` and the
     controller's interceptors. spark-api's envelope is a **per-controller**
     `ResponseInterceptor` (`libs/interceptors/`) applied via
     `@UseInterceptors(ResponseInterceptor)` — **not global** (~55 of ~62
     controllers). It wraps the payload as **`{ data: T }`** with **no top-level
     `meta`**. A route whose controller *lacks* the decorator returns a **bare**
     payload, so its FE type must be `T`, not `{ data: T }` — check the actual
     controller, don't assume every route is enveloped. There is **no
     `ClassSerializerInterceptor`** and no `@Exclude` / `@Expose` anywhere:
     entities serialize as-is, so every column is on the wire unless the service
     omits it in code (a leaked sensitive field is a finding, not an omission). The
     error body (custom `exceptionFactory` + `HttpExceptionsFilter`) is
     `{ statusCode, error, message }`. Miss these and the diff returns false
     "aligned."

2. **Normalize each side** into a field list: name, type, optional?, nullable?,
   enum values, nested shape. **Capture the top-level response shape too** —
   envelope wrapping (`{ data: T }`), `T` vs `T[]` vs **nestjs-paginate**
   `{ data: T[], meta, links }` (which nests *inside* the envelope ⇒ the wire is
   `{ data: { data: T[], meta, links } }`, read on the FE as `res.data.data.data`),
   and unserialized fields — not just leaf fields.

3. **Diff field-by-field** using `references/type-mapping.md`.

4. **Classify** each mismatch by severity using `references/severity.md`.

5. **Report** using `references/report-template.md`: a findings table with
   `field | BE file:line | FE file:line | mismatch | severity | fix`, plus a
   merge-order note (which repo's PR must land first).

6. **Prescribe the minimal fix on the correct side.** Default to fixing the FE
   to match the BE contract, unless the BE is the actual bug. Do **not** propose a
   shared-types layer or codegen as "the fix" — that's out of scope here; if drift
   is systemic, note it as a follow-up, don't scope-creep the review.

## Guardrails (the Supaclass-specific judgment)

- **Trust runtime validators over inferred TS.** spark-api runs with TS
  strictness off (`strictNullChecks: false`, `any` tolerated), so declared and
  inferred types can lie. The authoritative **request** contract is the
  class-validator DTO (its decorators, not the field's TS type); the authoritative
  **response** contract is what is actually serialized (entity + interceptors /
  transforms), not the declared return type.
- **`synchronize: true` means entity = live schema.** There are no migrations; an
  entity field is the live column. Treat entity shape as ground truth for
  response fields, and a nullable column as a nullable response field.
- **Casing & serialization.** Flag snake_case ↔ camelCase, `Date` ↔ ISO-string,
  and number ↔ string (Postgres `numeric` / `bigint` often serialize as strings).
- **Request-side string coercion.** `@Query` / `@Param` arrive as strings over the
  wire; a `page: number` is only a number if `ValidationPipe({ transform: true })`
  runs. Check that transform is enabled before trusting a numeric or boolean
  query/param type — distinct from `@Body` validation.
- **No codegen assumption.** Types are hand-synced, so a match today can drift
  tomorrow. Report even currently-aligned endpoints that the diff touches, so the
  reviewer knows they were checked (keep this to a one-line "verified aligned").
- **Read source, not tickets or prose.** Derive the contract from the actual DTOs,
  entities, interceptors, and zod schemas — never from a ticket description.

## References

- `references/type-mapping.md` — TS ↔ class-validator ↔ Postgres/serialization
  cheat-sheet; casing, date, number, null rules; response-envelope,
  `ClassSerializer`, and pagination shapes; global-prefix / versioning
  composition; request-side coercion rules.
- `references/severity.md` — blocker / high / medium / low definitions with
  examples.
- `references/report-template.md` — the findings-table + merge-order output format.
