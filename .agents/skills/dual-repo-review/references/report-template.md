# Report template

One report for the pair. Emit exactly this shape so results are scannable and
comparable across runs.

---

## Dual-repo review — <feature name>

**Pair:** spark-api [#85](…) `<title>` · spark-web [#73](…) `<title>`
**Matched on:** `<endpoint path / feature vocabulary>` — *not* module name (they differ)
**Size:** spark-api 34 files (+2476/−2) · spark-web 29 files (+2039/−32)
**Status:** `<both open, neither draft | one in active development — advisory only>`
**Delegated:** `self-review` ×2 · `api-contract-check` on `<n>` endpoint(s)
**Review boundary — API:** base `<ref>` @ `<base SHA>` · merge-base `<SHA>` · head `<SHA>`
**Review boundary — web:** base `<ref>` @ `<base SHA>` · merge-base `<SHA>` · head `<SHA>`
**Boundary revalidated:** `<timestamp>` — `<unchanged | moved; clearance discarded>`

### Verdict

> **Do not merge yet.** One blocker in the seam (event added backend-side, absent
> from the frontend enum) and one ordering hazard (`submission.status` narrows a
> type, destructive under `synchronize: true`). spark-api is otherwise clean;
> spark-web has 2 mediums.

Rules: any blocker or unresolved high from any origin blocks the **pair**. An
unresolved ordering hazard blocks the pair even when both halves are individually
clean. A half that is clean does not merge alone if landing it first breaks
production. If the verdict differs per half, say which is cleared and which is
blocked. If either review boundary moved, use **incomplete / human-review
required** until the affected review reruns. Also use incomplete when any
delegated `self-review` or `api-contract-check` fails, degrades, or returns
incomplete; partial evidence can never clear the pair.

### Findings by origin

Group by who found it, so it's obvious what's delegated and what's new here.

**spark-api** — via `self-review`

| file:line | sev | what | fix direction |
|---|---|---|---|
| `process-insight.controller.ts:14` | high | no `@UseInterceptors(ResponseInterceptor)` | add it; frontend unwraps `res.data.data` |

**spark-web** — via `self-review`

| file:line | sev | what | fix direction |
|---|---|---|---|
| `process-insights.ts:44` | medium | mutation invalidates list but not detail | add the detail `QueryKey` |

**REST seam** — via `api-contract-check`

| field | sev | BE | FE | mismatch |
|---|---|---|---|---|
| `rolledUpAt` | high | `…rollup.entity.ts:22` nullable | `process-insights.ts:18` non-null | FE must allow `null` |

**Cross-repo seam** — this skill

| # | sev | seam | what |
|---|---|---|---|
| 1 | **blocker** | event contract | `ProcessInsightReady` added to `event-types.const.ts:13`, absent from `use-event-invalidation.ts` `EventType` — no switch case, so nothing invalidates. Silent stale UI, no error. |
| 2 | low | enum parity | `ProcessInsightStatus` gained `Skipped`; frontend union has 3 of 4 members |
| 3 | — | orphan check | all 4 new routes consumed; all new `Endpoint` entries resolve. Clean. |

### Sequenced merge plan

Ordered and executable, with verification between steps. See
`references/deploy-ordering.md`.

1. **Before any deploy:** provision the new SQS queue (`scripts/setup-queue.sh`; new
   constant in `libs/messaging/src/const.ts:8`).
2. Fix seam blocker #1 and the ordering hazard below.
3. Merge + deploy **spark-api #85**. Schema effect: **3 new tables** (additive,
   safe) + **4 edits to existing entities**, of which `submission.status` narrows a
   type — **destructive**, needs additive-then-migrate, not in-place.
4. Verify: the new route returns `{ "data": … }`; the consumer logs a successful poll.
5. Before frontend deployment, run the checks discovered from the target
   branch's package scripts and CI configuration. Record exact commands/results;
   a failure blocks the sequence, and missing coverage must be stated explicitly.
6. Merge + deploy **spark-web #73**.
7. Perform risk-specific browser/runtime verification against the deployed pair.

**Deploy window:** state it always, even when fine.

> **Compatible.** Backend changes are additive from the old bundle's perspective, so
> users on the pre-deploy frontend are unaffected between steps 3 and 6.

or

> **Not compatible.** `rolledUpAt` is renamed, so between steps 3 and 6 every user on
> the old bundle sees a blank Process panel. Make the backend serve both names for
> one release, then narrow after the frontend ships. Deploying back-to-back shortens
> the outage; it doesn't remove it.

### Follow-ups (out of scope)

Only when the pair reveals something systemic — one line each, no refactor proposal.

> The `EventType` enum is hand-mirrored in both repos with no codegen — the same
> silent-drift class as the API types, and unguarded. 2nd occurrence. Worth a shared
> source or a lint, tracked separately.

---

## When one repo is missing

Do not guess the other side.

> **Cannot complete.** Only `spark-web` is checked out, so the REST seam, the event
> contract, and orphan detection are unavailable — all three need both sides. Ran
> `self-review` on spark-web alone: 2 mediums, no blockers. **Incomplete / human
> review required; no merge clearance.** Re-run with `../spark-api` present.

## When the sibling doesn't exist

An orphan is a finding, not a footnote.

> **No sibling change found.** spark-api #85 adds 4 routes under
> `/process-insights`; no spark-web branch or PR consumes them, and no `Endpoint`
> entry references them. Either the frontend half hasn't been opened yet (say so and
> re-run when it is), or this backend intentionally ships inert. **Incomplete /
> human-review required** until intent is confirmed; if the sibling is required,
> the verdict is **do not merge**.
