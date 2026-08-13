# Supaclass advisory reviewer pilot

Status: active after the reviewer-policy PRs merge

Scope: `spark-api` and `spark-web` pull requests

Owner: human maintainers; Codex remains an additional reviewer

## Decision under test

Codex automatic GitHub review is useful as an advisory P0/P1 review pass when it
has current repository guidance. It does not approve, merge, deploy, satisfy the
human-approval rule, or replace CI. No custom reviewer service or Vercel/Eve
deployment is part of this pilot.

## Review outcome taxonomy

- **agent-clear** — Codex reports no major issue across the exact current review
  boundary. A human review is still required.
- **blocker** — Codex reports a concrete P0/P1 issue confirmed by a human.
- **human-review** — the review is absent/stale, tooling failed, current policy
  did not apply, the actual base or sibling/stack dependency is unavailable, or
  the change needs product/domain judgment. Uncertainty never becomes clear.

## Evaluation population

Record three cohorts separately:

1. **Prospective:** the first 20 consecutive eligible application PRs whose
   ready-for-review timestamp occurs after both reviewer policies merge.
   Eligibility requires the effective policy revision in the reviewed branch.
   Drafts, bots, documentation-only PRs, and PRs labeled `reviewer-eval` are
   recorded as excluded rather than silently skipped.
2. **Historical calibration:** 10-15 consecutive Codex-reviewed PRs returned by
   one fixed repository/date query recorded before selection. Legacy/no-policy
   reviews are labeled and are never pooled with prospective results.
3. **Seeded evaluation:** synthetic, never-merge PRs labeled `reviewer-eval`.
   These do not count toward prospective coverage or accuracy.

The attempt ledger records every candidate and its eligibility decision. Changes
to models, automatic-review settings, policy, taxonomy, or metrics start a new
`evaluation_version`; the exact `policy_version` is the applicable `AGENTS.md`
commit SHA.

## Immutable review boundary

Create one attempt row for every review run and record:

- `reviewed_base_ref` and `reviewed_base_sha`;
- `merge_base_sha`;
- `reviewed_head_sha`;
- the GitHub review's `review_commit_id`;
- ready-for-review, trigger, start, and completion timestamps.

A review is current only when the head and entire effective base boundary still
match. A force-push, new head commit, base branch commit, retarget, or changed
merge base makes it stale even when the PR head is unchanged. Trigger a fresh
review where supported; until it completes, classify the PR `human-review`.
Stacked PRs are always evaluated against their actual base, never silently
against `main`.

## Auditable records

Use two normalized ledgers:

- [`reviewer-attempt-ledger.csv`](reviewer-attempt-ledger.csv): one row per
  trigger/review boundary for eligibility, automatic coverage, latency,
  staleness, and outcome.
- [`reviewer-finding-ledger.csv`](reviewer-finding-ledger.csv): one row per
  Codex or human P0/P1 finding, linked to an attempt, with severity, evidence,
  matching finding, and maintainer adjudication.

The model never adjudicates its own findings. A maintainer records `confirmed`,
`false_finding`, `missed_issue`, `pre_existing`, or `out_of_scope`, with an
evidence link. Reruns get new attempt IDs; findings are never overwritten.

Predeclared formulas:

- **Automatic coverage:** eligible prospective PRs with a completed automatic
  review on their final boundary / all eligible prospective PRs.
- **Miss rate:** unmatched human P0/P1 findings / all human P0/P1 findings in
  eligible prospective final-boundary attempts.
- **False-finding rate:** Codex P0/P1 findings adjudicated `false_finding` / all
  adjudicated Codex P0/P1 findings in eligible prospective final attempts.
- **Latency:** minutes from ready-for-review to the first completed automatic
  review on the same boundary; report median and p90, with timeouts retained.

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

Each seed predeclared as P0/P1 must produce a material Codex finding. Seeds
expected to yield `human-review` (for example missing external stack context)
are diagnostic and reported separately, never counted as a successful catch.

## Predeclared success gates

Continued advisory use requires:

- 100% of all seeds predeclared P0/P1 produce a material finding;
- no eligible prospective `agent-clear` contains a human-found P0/P1;
- 100% of final outcomes match the complete current review boundary;
- automatic review coverage is at least 95%;
- median automatic-review latency is under 15 minutes; and
- raw false-finding counts/rates remain low enough that maintainers continue to
  inspect and act on reviews.

Twenty prospective PRs plus seeds can justify continued advisory use. They
cannot justify removing human review or enabling automated approval/merge.

## Operating rules

- Keep one other-human approval and deterministic required checks at `main`.
- Do not use Codex approval as policy evidence; record findings only.
- Do not use `@codex fix`; review and branch-writing authority stay separated.
- Never treat unavailable, stale, legacy/no-policy, or incomplete context as
  clearance.

## Exit review

Publish the raw ledgers and choose: continue unchanged, refine and rerun, or
disable automatic review. Automated approval, clearance, or merge requires a
separate ADR, larger stratified sample, allowlist, kill switch, immutable audit
trail, and incident/rollback plan.
