# Supaclass advisory reviewer pilot

Status: active after the reviewer-policy PRs merge

Scope: `spark-api` and `spark-web` pull requests

Owner: human maintainers. Automatic reviewers are additional, advisory
reviewers — currently Codex and Claude, both invoked via GitHub review. See
[`multi-reviewer-matching.md`](multi-reviewer-matching.md) for how findings
from more than one automatic reviewer are compared and reconciled; that
document extends this one and does not replace it.

## Decision under test

Automatic GitHub review from a configured reviewer is useful as an advisory
P0/P1 review pass when it has current repository guidance. No configured
reviewer approves, merges, deploys, satisfies the human-approval rule, or
replaces CI. No custom reviewer service or Vercel/Eve deployment is part of
this pilot.

## Review outcome taxonomy

- **agent-clear** — every automatic reviewer configured for the repository
  reports no major issue across the exact current review boundary. A human
  review is still required. On an individual ledger attempt row,
  `outcome=agent-clear` means only that one reviewer, alone, found no major
  issue on that boundary — the true PR-level "every reviewer clear"
  disposition is a separately computed judgment (see AGENTS.md's
  merge-readiness section), not something any single attempt row can answer
  by itself; see `multi-reviewer-matching.md`'s "Recommended resolutions" #10.
- **blocker** — an automatic reviewer reports a concrete P0/P1 issue confirmed
  by a human.
- **human-review** — a review is absent/stale, tooling failed, current policy
  did not apply, the actual base or sibling/stack dependency is unavailable, or
  the change needs product/domain judgment. Uncertainty never becomes clear.
  Record *why* in `non_completion_reason` on the attempt row — a reviewer's
  capacity limit (e.g. a quota wall) is a different fact than a reviewer
  running and declining to render a judgment, even though both resolve to
  `human-review` here.

## Evaluation population

Record three cohorts separately:

1. **Prospective:** the first 20 consecutive eligible application PRs whose
   ready-for-review timestamp occurs after both reviewer policies merge.
   Eligibility requires the effective policy revision in the reviewed branch.
   Drafts, bots, documentation-only PRs, and PRs labeled `reviewer-eval` are
   recorded as excluded rather than silently skipped.
2. **Historical calibration:** 10-15 consecutive Codex-reviewed PRs returned by
   one fixed repository/date query recorded before selection. Legacy/no-policy
   reviews are labeled and are never pooled with prospective results. This
   cohort is **frozen as legacy, Codex-only** as of Claude joining as a second
   standing reviewer — it is not rebuilt in parallel for Claude, since Claude's
   review activity only began 2026-08-15 and there is no comparable backlog to
   retroactively calibrate. Claude's calibration runs through the prospective
   cohort below instead, which is per-reviewer by design.
3. **Seeded evaluation:** synthetic, never-merge PRs labeled `reviewer-eval`.
   These do not count toward prospective coverage or accuracy.

The separate [`spark-skills` backlog calibration](spark-skills-backlog-pilot.md)
tests reviewer mechanics and development-tool judgment. Never pool it with the
application cohorts or use it to claim app-specific accuracy. A fourth,
narrower cohort, `matcher_calibration`, holds worked examples used only to
validate the cross-reviewer matching procedure in
[`multi-reviewer-matching.md`](multi-reviewer-matching.md); it never counts
toward any reviewer's accuracy and is never pooled with the other three.

The attempt ledger records every candidate and its eligibility decision, one
row per `(reviewer_tool, boundary)`. Adding, removing, or reconfiguring a
reviewer is itself a change to "automatic-review settings" and starts a new
`evaluation_version`, same as a model or policy change — report metrics
per-`reviewer_tool` and pooled, never pooled-only, since pooling silently
answers "is the combined system adequate" while hiding "would dropping either
reviewer lose something." The exact `policy_version` is the applicable
`AGENTS.md` commit SHA at the time of that reviewer's attempt (reviewers on the
same boundary can have different `policy_version`s if one reviewed before a
policy change and another after — record what was actually current for each).

## Immutable review boundary

Create one attempt row for every review run and record:

- `reviewed_base_ref` and `reviewed_base_sha`;
- `merge_base_sha`;
- `reviewed_head_sha`;
- the GitHub review's `review_commit_id`;
- ready-for-review, trigger, start, and completion timestamps.

A review is current only when the head and entire effective base boundary still
match. A force-push, new head commit, retarget, or changed **merge base**
makes it stale even when the PR head is unchanged. For a branch that has not
rebased, `reviewed_base_sha` (the base ref's raw tip) can drift while
`merge_base_sha` (the fork point, which fixes the actual reviewed diff) stays
identical — that is not staleness; two reviewers who reviewed the identical
`(merge_base_sha, reviewed_head_sha)` pair reviewed the identical diff,
regardless of how far the base ref's tip moved between them. Test currency on
`merge_base_sha`, not on raw `reviewed_base_sha` equality. A genuine base
branch commit that changes the merge base does make it stale. Trigger a fresh
review where supported; until it completes, classify the PR `human-review`.
Stacked PRs are always evaluated against their actual base, never silently
against `main`.

## Auditable records

Use two normalized ledgers:

- [`reviewer-attempt-ledger.csv`](reviewer-attempt-ledger.csv): one row per
  `(reviewer_tool, boundary)` trigger/review for eligibility, automatic
  coverage, latency, staleness, and outcome. `reviewer_tool`,
  `reviewer_identity`, and `reviewer_model` identify which reviewer produced
  the row; `non_completion_reason` distinguishes a capacity failure (e.g. a
  quota wall) from other reasons a review didn't complete.
- [`reviewer-finding-ledger.csv`](reviewer-finding-ledger.csv): one row per
  automatic-reviewer or human P0/P1 finding, linked to an attempt, with
  severity, evidence, `root_cause_key`, cross-reviewer match, and maintainer
  adjudication. See [`multi-reviewer-matching.md`](multi-reviewer-matching.md)
  for how findings from different reviewers describing the same defect are
  matched to one `root_cause_key`.

The model never adjudicates its own findings, and never adjudicates a proposed
match involving its own finding. A maintainer records `confirmed`,
`false_finding`, `missed_issue`, `pre_existing`, or `out_of_scope`, with an
evidence link, and separately confirms or rejects any proposed
cross-reviewer match. Reruns get new attempt IDs; findings are never
overwritten.

Predeclared formulas, computed **per `reviewer_tool` and pooled**, never
pooled only:

- **Automatic coverage:** eligible prospective PRs with a completed automatic
  review on their final boundary / all eligible prospective PRs. Report
  separately from coverage lost specifically to `non_completion_reason =
  quota_exhausted`, since a capacity ceiling and a judgment gap need different
  fixes.
- **Miss rate:** unmatched human P0/P1 findings / all human P0/P1 findings in
  eligible prospective final-boundary attempts.
- **False-finding rate:** P0/P1 findings adjudicated `false_finding` / all
  adjudicated P0/P1 findings in eligible prospective final attempts, for that
  reviewer.
- **Latency:** minutes from ready-for-review to the first completed automatic
  review on the same boundary, per reviewer; report median and p90, with
  timeouts retained. This deliberately uses the *first* completed review on a
  boundary even when a later review from the same reviewer is the canonical
  one for finding-accuracy purposes (see `review_sequence`/
  `is_canonical_for_boundary` in `multi-reviewer-matching.md`) — latency asks
  "how fast was initial signal," a different question from "which review's
  findings do we trust."
- **Corroboration rate and unique-catch rate:** once more than one automatic
  reviewer is configured, also report the share of confirmed root causes found
  by more than one reviewer, and the share found by exactly one — see
  `multi-reviewer-matching.md`. A high pooled coverage number can still hide a
  reviewer whose unique-catch rate is near zero, or one whose absence would
  lose real findings; report both so that fact is visible.

Also report raw numerators/denominators, stale attempts, and post-merge defects
attributable to the reviewed diff. Do not hide disagreement behind a score.

## Seeded evaluation set and safety

Track seeds in [`reviewer-seed-ledger.csv`](reviewer-seed-ledger.csv), including
the production-shaped defect, expected severity/outcome, and observed finding.
Use fake, non-live credential patterns. Do not seed only a comment or fixture
when the real failure would be executable code.

Cover at least: missing API guard/tenant scope; raw entity exposure; destructive
`synchronize: true` schema edits; incorrect DTO validation; missing envelope;
frontend/backend contract drift; wrong envelope depth; ungated queries; stale
mutation caches; unsafe stack/deploy order; a fake secret or sensitive log; and
prompt injection in untrusted PR metadata/source.

Every seed uses an unmistakable `[REVIEWER EVAL - DO NOT MERGE OR DEPLOY]` title
and `reviewer-eval` label. Before opening one, verify that no preview, deploy,
release, shared environment, or production automation consumes its branch or
label; disable such automation for the seed. Seeds contain no live customer data
or credentials and are closed without merge after results are recorded.

Each seed predeclared as P0/P1 must produce a material finding from every
automatic reviewer configured for that repository at seed time. Seeds
expected to yield `human-review` (for example missing external stack context)
are diagnostic and reported separately, never counted as a successful catch.
A seed one reviewer catches and another misses is a real result — record it
per reviewer rather than treating "at least one caught it" as sufficient.

## Predeclared success gates

Continued advisory use of a given automatic reviewer requires, for that
reviewer:

- 100% of all seeds predeclared P0/P1 produce a material finding from it;
- no eligible prospective `agent-clear` contains a human-found P0/P1 it should
  have caught;
- 100% of final outcomes match the complete current review boundary;
- its automatic review coverage is at least 95%, reported separately from any
  share lost to `non_completion_reason = quota_exhausted`;
- its median automatic-review latency is under 15 minutes; and
- its raw false-finding counts/rates remain low enough that maintainers
  continue to inspect and act on its reviews.

Twenty prospective PRs plus seeds, evaluated per reviewer, can justify
continued advisory use of that reviewer. They cannot justify removing human
review, enabling automated approval/merge, or dropping any other configured
reviewer solely because its findings overlap with one that already passed —
see the unique-catch rate in `multi-reviewer-matching.md` before dropping one.

## Operating rules

- Keep one other-human approval and deterministic required checks at `main`.
- Do not use any automatic reviewer's approval as policy evidence; record
  findings only.
- Do not use an automatic reviewer's write/auto-fix capability (Codex's is
  invoked by commenting `"@codex address that feedback"`) on any repository in
  this pilot; review and branch-writing authority stay separated for every
  configured reviewer. No Claude-equivalent trigger currently exists in this
  repo's history (only `@claude review`/`@claude review always` have been
  observed) — this rule is preventative for Claude, not a response to an
  existing capability, and should be revisited if that changes.
- Never treat unavailable, stale, legacy/no-policy, or incomplete context as
  clearance — this includes a reviewer that is unavailable due to a capacity
  limit, not only one that is absent or misconfigured.

## Exit review

Publish the raw ledgers and choose: continue unchanged, refine and rerun, or
disable automatic review. Automated approval, clearance, or merge requires a
separate ADR, larger stratified sample, allowlist, kill switch, immutable audit
trail, and incident/rollback plan.
