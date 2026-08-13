---
name: dual-repo-review
description: >-
  Review a change that spans both Supaclass repos (spark-api + spark-web) as one
  unit. Use it when a feature ships as a paired backend and frontend change — two
  open PRs, two local branches, or one feature touching both checkouts. It
  orchestrates rather than duplicates: runs self-review inside each repo and
  api-contract-check across the REST seam, then owns what neither can see from one
  side — pair integrity (is the sibling change actually there, or did one side
  ship orphaned), the seam inventory beyond REST (event-type constants consumed by
  frontend cache invalidation, enum and const parity, per-controller envelope
  presence), and merge/deploy ordering under synchronize:true, including whether
  the backend stays backward-compatible with the old frontend during the deploy
  window and whether out-of-band prerequisites like queue setup must run first.
  Revalidates both review boundaries, then emits one aggregate merge /
  do-not-merge / incomplete verdict and a sequenced merge plan. It reviews; it
  does not rewrite.
metadata:
  supaclass-repos: [spark-api, spark-web]
  maturity: vertical-slice
---

# dual-repo-review

A Supaclass feature usually lands as two changes in two repos, reviewed
separately, merged separately, and deployed separately. Every existing gate is
**single-repo**: `self-review` runs inside one checkout, and `api-contract-check`
compares REST shapes but says nothing about sequencing or non-REST seams. So the
failure that actually bites — the two halves being individually correct but wrong
*together*, or landing in the wrong order — has no owner.

This skill is that owner. It delegates the per-repo and REST work to the existing
skills and spends its own effort on the seam and the sequence.

## When this fires

Run it when one logical change touches both repos:
- two open PRs that implement the same feature;
- two local feature branches;
- a change in one repo that *should* have a sibling and may not.

Skip it when the change is genuinely confined to one repo with no wire impact —
run `self-review` alone. If both halves are already merged and deployed, this is
retrospective; say so and scope to what's still actionable.

## Inputs

- **Two changes to compare.** Accept PR numbers/URLs (`gh pr view` / `gh pr diff`
  against `bennettl/spark-api` and `bennettl/spark-web`), two local branches, or a
  feature name to search for. Prefer PRs when they exist — that's what gets merged.
- **Both repo roots.** Default to sibling checkouts (`../spark-api`,
  `../spark-web`). Both are required for the cross-repo checks; with one, stop and
  say what you cannot do rather than guessing the other side. For every PR or
  named-local-branch input, each root must be a clean checkout whose `HEAD`
  equals the captured head SHA; otherwise create an isolated worktree at that
  SHA. Never label evidence with one boundary while delegates read another.
- **The in-flight caveat.** If a PR is still being actively worked, say so and
  frame findings as advisory. Return **incomplete / human-review required** until
  a stable boundary can be reviewed; never issue merge clearance on a moving
  target.

## Method

1. **Establish the pair.** Find both halves and confirm they're the same feature.
   Before reading either diff, capture an immutable review boundary for each
   half: repo, PR/base ref, base SHA, merge-base SHA, and head SHA. Include both
   tuples in the report and pass the matching root and boundary into delegated
   reviews. Capture mergeability/test-merge status for every input: use PR
   metadata/test merge for open PRs and a non-mutating merge-tree check of each
   local head against its established base. A conflicted or unresolved state is
   **incomplete / human-review required**. A branch name alone is not a review
   boundary. Materialize both captured heads as described under Inputs before
   invoking a delegate.
   **Do not match on name** — the repos don't agree: a backend `src/process-insight/`
   module pairs with a frontend `src/api/process-insights.ts`. Match on the
   **endpoint path** and the **feature vocabulary** in the diff. Then check pair
   integrity:
   - Does each half have a sibling at all? A backend PR exposing new routes with no
     frontend consumer, or a frontend PR calling routes no backend PR adds, is the
     finding — not a footnote.
   - Do they cover the same scope, or does one implement more than the other
     exposes?

2. **Delegate the per-repo review.** Run **`self-review`** once per repo, **passing
   the repo root explicitly** (`../spark-api`, then `../spark-web`). This matters:
   `self-review` detects the repo from files at the root of its target, so a call
   that names no root falls back to the working directory — and when that's a third
   directory like this registry, detection returns **"neither"** and it silently
   degrades to stack-neutral checks. Confirm in its output that it identified the
   intended repo before trusting its findings; if it reports "neither," the
   delegation failed and the per-repo half of this review is missing. Do not
   re-derive its checks here — collect its findings and carry the severities into
   the aggregate verdict. A failed or **incomplete** delegated review makes the
   aggregate result incomplete; absence of blocker findings is not clearance.

3. **Delegate the REST seam.** Run **`api-contract-check`** for each endpoint the
   pair touches. It owns field-by-field shape, envelope, pagination, casing, and
   date/number serialization. Do not re-diff types here — pass it the endpoints and
   consume its findings. A failed, single-repo-degraded, or **incomplete**
   contract check makes the aggregate result incomplete; partial REST evidence
   can never clear the pair.

4. **Own the seam inventory** — the cross-repo contact points nothing else checks.
   Full list in `references/seam-inventory.md`. In brief:
   - **Event contracts.** Backend event-type constants
     (`src/events/const/event-types.const.ts`) are consumed by the frontend's
     `use-event-invalidation.ts` to invalidate React Query caches. A renamed or
     added event name is a silent, string-matched contract that
     `api-contract-check` does not cover. Verify both sides agree, and that new
     events actually invalidate the right `QueryKey`s.
   - **Enum / const parity.** Backend `enum.ts` files versus frontend literal
     unions or hand-written equivalents.
   - **Envelope presence per new controller.** Every new backend controller needs
     `@UseInterceptors(ResponseInterceptor)` or the frontend's `res.data.data`
     unwrap breaks. Cheap to check, silent when wrong.
   - **Endpoint-map coverage.** Every new backend route has a frontend `Endpoint`
     entry (or is intentionally unconsumed), and every new `Endpoint` resolves to a
     real backend route.

5. **Own the ordering.** Determine merge and deploy sequence per
   `references/deploy-ordering.md`. The three questions that matter:
   - **Which lands first?** Backend, almost always — a frontend calling a route
     that doesn't exist yet is a 404. State it explicitly rather than assuming.
   - **What does the backend deploy mutate?** Under `synchronize: true` every
     entity edit is a live schema change. New tables are additive and safe;
     **edits to existing entities are the risk.** Enumerate them and flag
     destructive shapes (rename = drop + add).
   - **Is the backend backward-compatible with the *old* frontend?** Between the
     two deploys, production runs new backend against old frontend. Nobody checks
     this and it is the most common dual-repo production break.
   - **Are there out-of-band prerequisites?** Queue provisioning
     (`scripts/setup-queue.sh`, `libs/messaging` const changes), a `scripts/*.sql`
     or `onetime/*` backfill, or a new env var must be done *before* the backend
     boots. A consumer registered against a queue that doesn't exist fails at
     runtime, not at build.

6. **Revalidate, aggregate, and verdict.** Immediately before issuing a verdict,
   resolve both boundary tuples again and compare them with the captured values.
   Also re-check that each materialized checkout still has the captured `HEAD`
   and that every PR/local branch remains conflict-free against its captured
   base. If a base SHA, merge-base SHA, head SHA, checkout `HEAD`, or mergeability
   state moved or became unresolved,
   discard any clearance and return **incomplete / human-review required** until
   the affected review is rerun. Then emit **one** report per
   `references/report-template.md`: findings grouped by origin (spark-api,
   spark-web, seam, ordering), a sequenced merge plan, and a single
   **merge / do-not-merge / incomplete** verdict. Any blocker or unresolved high
   from **any origin** (delegate, REST seam, cross-repo seam, or ordering), or an
   unresolved ordering hazard, blocks the pair — a half that is individually
   clean does not merge alone if landing it first breaks production.

## Guardrails (the Supaclass-specific judgment)

- **Orchestrate; don't reimplement.** `self-review` owns per-repo rules;
  `api-contract-check` owns REST field shape. If you find yourself diffing a DTO
  against an interface here, stop — you're duplicating a spoke, and the two will
  drift. Your job is the seam and the sequence.
- **Verdict on the pair, not on halves.** Two independently-clean PRs can still be
  do-not-merge if the order is wrong or the deploy window breaks. Conversely, don't
  block a clean backend on a frontend nit — say which half is blocked and why.
- **`synchronize: true` makes deploy order a data question, not a preference.**
  Weigh data loss before ergonomics. If an entity edit is destructive, the fix
  direction is usually additive-then-migrate, not rename-in-place.
- **The deploy window is real.** Always state what production looks like between
  the two merges, even when the answer is "compatible, no window risk."
- **Match on endpoints, not names.** The repos' vocabularies diverge (singular
  module versus plural api file). A name-based pair match produces confident
  false negatives.
- **Never hardcode model IDs or context windows** in findings or examples. Where a
  diff adds LLM tasks or prompt-instruction assets, refer to the config/service
  value that selects the model. See `meta/model-currency.md`.
- **Flag any added secret; never print its value.** Both repos already carry a
  committed-credential problem — don't add a third, and don't re-litigate the
  known ones as new findings.
- **Scope to the diff.** Pre-existing cross-repo drift outside the changed lines
  is not this review's job; note it once as a follow-up at most.
- **Respect in-flight work.** A PR under active development gets advisory
  findings plus an **incomplete / human-review required** disposition, never
  merge clearance. Re-run at a stable boundary.

## References

- `references/seam-inventory.md` — every cross-repo contact point, what owns it,
  and which are *not* covered by `api-contract-check` (events, enums, envelope,
  endpoint-map coverage).
- `references/deploy-ordering.md` — merge/deploy sequencing, `synchronize: true`
  schema-mutation classes, the deploy-window compatibility question, and
  out-of-band prerequisites.
- `references/report-template.md` — the combined output: findings by origin,
  sequenced merge plan, one aggregate verdict.
