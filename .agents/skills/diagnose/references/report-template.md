# Report template

Emit exactly this shape so diagnoses are scannable and comparable across runs.

---

## Diagnosis — <one-line symptom>

**Symptom class:** `<A. blank/undefined | B. stale | C. auth | D. tenant/authz | E. serialization | F. write validation | G. post-deploy schema | H. async | I. render>`
**Repos read:** spark-api @ `<path>` · spark-web @ `<path>` *(say which were absent)*
**Reproduction:** `<route / action / preconditions>` — or `not reproduced locally, diagnosed from code + <artifact>`

### Root cause

> **Confirmed.** `<one or two sentences>` — the FE unwraps `res.data.data` at
> `src/api/grades.ts:31`, but `GradeController` (`grade.controller.ts:14`) has no
> `@UseInterceptors(ResponseInterceptor)`, so the route returns a bare array and
> the extra `.data` is `undefined`.

Confidence is a required label, not a hedge to omit:

- **Confirmed** — every link in the chain has file:line evidence.
- **Likely** — the mechanism is evidenced but one link is inferred; say which.
- **Unresolved** — no candidate confirmed. Say so, and give the single next
  diagnostic step. Do not dress a hypothesis up as a cause.

### Evidence

| # | Claim | File:line | What it shows |
|---|-------|-----------|---------------|
| 1 | FE expects the `{ data }` envelope | `spark-web/src/api/grades.ts:31` | `res.data.data` unwrap on a non-paginated route |
| 2 | BE route does not add it | `spark-api/src/grade/controller/grade.controller.ts:14` | class has `@Controller` but no `@UseInterceptors(ResponseInterceptor)` |
| 3 | Sibling controllers do add it | `spark-api/src/assignment/controller/assignment.controller.ts:16` | establishes the convention this route missed |

### Ruled out

State what you checked and rejected, so the next person doesn't re-walk it.

- **Field drift** — `Grade` entity fields match the FE `interface` one-for-one
  (`grade.entity.ts:8-27` vs `grades.ts:4-18`).
- **Ungated query** — `enabled: !!selectedCourse?.id` present at `grades.ts:22`.

### Fix plan

Ranked, **minimal-first**, each with its tradeoff. Recommend one.

| # | Fix | Scope | Tradeoff |
|---|-----|-------|----------|
| 1 ✅ | Add `@UseInterceptors(ResponseInterceptor)` to `GradeController` | 1 line, BE | Matches every other controller; no FE change. **Recommended.** |
| 2 | Change the FE to unwrap `res.data` for this route | 1 line, FE | Leaves this route's wire shape inconsistent with the other ~65 modules; the next reader hits the same trap. |

For each recommended fix, state explicitly when it applies:

- **Schema consequence** — if the fix touches an entity or `@Column`: this is a
  live `synchronize: true` migration on next deploy. Say whether it is destructive
  (a rename is a drop + add), and whether a `scripts/*.sql` or `onetime/*` backfill
  is needed.
- **Merge order** — if the fix spans both repos, which lands first and why.
- **Contract handoff** — if the cause is drift, name the endpoint and hand it to
  **`api-contract-check`** rather than enumerating fields here.

### Verify the fix

Concrete and checkable — the exact steps that turn the symptom off:

1. Restart the API; `GET /grades?filter.courseId=<id>` returns `{ "data": [ … ] }`.
2. Reload the grades panel for that course; rows render.
3. `pnpm build` in spark-web (this is where `tsc -b` runs — there is no standalone
   typecheck script) and `pnpm lint` in the touched repo.

Given spark-web has **no test framework** and spark-api has only ~5 spec files,
say plainly that verification is manual. Don't imply a test proved anything.

### Follow-ups (out of scope)

Only when the bug is an instance of a recurring class — one line, no refactor
proposal:

> 3rd missing-`ResponseInterceptor` bug this quarter. A `self-review` check exists
> for it; consider whether new controllers should be scaffolded with it instead.

---

## When nothing is confirmed

Do not pad. This is a valid and useful output:

> **Unresolved.** Three candidates remain live for a blank grades panel — envelope
> depth, a missing `ResponseInterceptor`, and field drift on `Grade`. They are
> indistinguishable from the screenshot alone.
>
> **Next step:** open the Network tab, trigger the panel, and send the request URL,
> status, and raw response body for the `/grades` call. That separates all three in
> one look.
