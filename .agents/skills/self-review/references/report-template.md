# Report template

Emit exactly this shape so a self-review is scannable and the verdict is
unambiguous. The verdict is the point — findings support it. Never issue a
merge verdict when the actual review boundary or required context is unknown.

---

## Self-review — <repo> @ `<branch>`

**Repo:** `<spark-api | spark-web | neither>` (detected via `<signal>`)
**Actual base:** `<ref>` @ `<base sha>` · **Merge base:** `<sha>` · **Head:** `<sha>`
**Files changed:** `<n>`
**Rules:** `references/<repo>-checks.md` + `AGENTS.md` `<loaded | absent — reference checklist only>`

A single run reviews **one** repo — the one you're in. Keep every file:line in the
findings below within that repo. (Example: a spark-api run.)

### Findings

| # | Severity | File:line | Finding | Fix direction |
|---|----------|-----------|---------|---------------|
| 1 | blocker | `src/users/user.controller.ts:31` | Returns raw `User` entity — leaks `passwordHash` (no serializer in this repo) | Select/omit columns in the service; return a shaped object, not the entity |
| 2 | high | `src/assignments/assignment.controller.ts:14` | New controller missing `@UseInterceptors(ResponseInterceptor)` — returns a bare payload, breaks spark-web's `res.data.data` unwrap | Add the decorator so responses are `{ data: T }` |
| 3 | medium | `src/grading/grading-pipeline.service.ts:88` | Leftover `console.log` in committed code | Remove it |

### Contract check needed

> The diff changes `POST /assignments` and its request DTO
> (`create-assignment.dto.ts:8`). **Run `api-contract-check`** scoped to that
> endpoint before merge — this gate does not diff FE↔BE types itself.
> (If the sibling spark-web checkout is absent, that skill degrades to
> single-repo self-consistency; the drift risk still stands.)

Omit this section if no wire-shape / route / api-module file changed.

### Verdict

State one, in bold, with the reason:

> **Do not merge.** 1 blocker (#1, leaked credential column) and 1 unresolved
> high (#2, missing response envelope). Fix #1 and #2, re-run self-review, and run
> `api-contract-check` before opening the PR.

or

> **Merge.** No blockers or highs. 1 medium (#3) — fix now or file as a
> follow-up; your call. No wire-shape changes, so no contract check needed.

If there are no findings at all:

> **Merge.** Reviewed `<n>` changed files against `references/<repo>-checks.md`;
> nothing flagged. No blockers, highs, mediums, or lows.

If the actual base, applicable policy, sibling contract, or other material
context cannot be established:

> **Incomplete — human review required.** The actual PR base could not be
> established, so this run cannot define the effective diff. Do not treat it as
> clearance; rerun against the exact base ref/SHA or obtain focused human review.

## Severity rubric

Rank by consequence, not by fix effort. Build CI and human review remain separate
gates; this skill covers judgment they do not automate. Blocker or any unresolved
high ⇒ **do-not-merge**. Unknown review boundary or material missing context ⇒
**incomplete / human-review required**.

- **blocker** — merging ships a crash, data loss, or a leaked secret/credential.
  Destructive `synchronize: true` rename/drop with data at risk; a returned
  entity leaking a secret column; an added committed secret; a write-path
  contract mismatch that drops or corrupts data.
- **high** — silently wrong data or a real security gap, no crash. Missing
  response envelope on a consumed controller; unintentionally public route;
  mutation that doesn't invalidate the cache; ungated query firing on
  `undefined`; hardcoded path bypassing the `Endpoint`/`QueryKey` maps; a
  read-path contract mismatch.
- **medium** — type-unsafe or inconsistent but tolerated today. Uncoerced
  numeric query param; missing `handleMutationError`; ad-hoc hex instead of
  `theme.ts`; leftover `console.log`.
- **low** — cosmetic, or a residual-risk follow-up that adds no new harm in this
  diff. Naming/ordering nits, comment drift; or a correct-but-incomplete
  remediation (e.g. a secret untracked here but still live in git history →
  rotate + purge as a follow-up). Report briefly; never block on a low.

When a finding sits between two levels, pick the higher and say why. A blocker or
unresolved high always forces do-not-merge; mediums and lows are the author's
call and never block on their own.
