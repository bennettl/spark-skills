# Report template

Emit exactly this shape so results are scannable and diffable across runs.

---

## API contract check — <scope>

**Repos:** spark-api @ `<path>` · spark-web @ `<path>`
**Endpoint(s):** `<METHOD /path>` → FE module `src/api/<module>.ts`
**Global wrappers seen:** `<TransformInterceptor / ClassSerializerInterceptor / none>`

### Findings

| # | Field | Severity | BE (file:line) | FE (file:line) | Mismatch | Fix |
|---|-------|----------|----------------|----------------|----------|-----|
| 1 | `gradedAt` | high | `grade.entity.ts:22` (`nullable: true`) | `grade.ts:14` (`gradedAt: string`) | BE nullable, FE non-null | FE → `gradedAt: string \| null`; zod `.nullable()` |
| 2 | `score` | medium | `grade.entity.ts:19` (`numeric`) | `grade.ts:12` (`score: number`) | numeric serializes as string | FE → `score: string` (or parse at boundary) |

If there are no findings:

> **No drift found.** Verified aligned: `<n>` fields across `<endpoint(s)>`.
> (Types are hand-synced with no codegen — re-run on the next shape change.)

### Verified aligned (touched, no change needed)

- `id`, `assignmentId`, `submittedAt` — match on name, type, nullability.

### Merge order

State which repo's PR must land first, and why:

> **spark-api first.** Finding #1 adds `gradedAt` nullability on the backend; the
> spark-web change depends on it. Merging FE first would type against a contract
> that doesn't exist yet.

If the change is FE-only (mirroring an already-shipped backend), say so:

> **spark-web only.** Backend contract already live; this aligns the FE mirror.

### Follow-ups (out of scope for this review)

Only if drift is systemic — e.g. "5th nullability drift this month on grades;
consider a shared type or codegen." Note it; don't fix it here.
