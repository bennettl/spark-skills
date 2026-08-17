# Cross-reviewer finding matching

Status: draft, not yet in effect. Extends [`reviewer-pilot.md`](reviewer-pilot.md)
now that Claude has joined Codex as a second automatic reviewer on `spark-api`
and `spark-web` pull requests (both are already invoked via GitHub review, see
`reviewer_tool` in the ledgers). This document defines how findings from
different reviewers on the same pull request are compared without collapsing
them into a single score, and without either reviewer adjudicating itself.

## Why this is needed

The original ledgers had no column for *which* reviewer produced an attempt or
a finding. That was adequate for a single-reviewer pilot; it stopped being
adequate the moment a second reviewer became a standing participant, because:

- Coverage, latency, and false-finding metrics become meaningless if rows from
  different reviewers are pooled without being labeled.
- A capacity failure (a reviewer refusing to run) is not the same signal as a
  reviewer running and finding nothing, but the taxonomy folded both into
  `human-review`.
- Two reviewers describe the same underlying defect in different words,
  anchored to different files or lines. Naive `file:line` matching treats
  these as unrelated; naive keyword matching over-merges unrelated findings
  that happen to touch the same function.

## Schema changes

**`reviewer-attempt-ledger.csv`** adds:

- `reviewer_tool`, `reviewer_identity`, `reviewer_model` — which reviewer ran,
  its GitHub bot login, and its model if disclosed (`undisclosed` otherwise —
  neither the Codex GitHub app nor Claude's currently expose this).
- `review_id` — GitHub's own numeric review ID (the API review object's `id`
  field, e.g. `4851514032`), distinct from the pre-existing `review_commit_id`
  column (the API review object's `commit_id` field — a SHA, the commit that
  specific review targeted, which can differ from the ledger's own
  `reviewed_head_sha` if new commits land after a review is submitted). Both
  are needed: `review_commit_id` detects staleness, `review_id` is what lets
  anyone deep-link to the actual review thread on GitHub for audit. Citing a
  review only in free-text `evidence`, as the first draft of this document did,
  is how a wrong ID went unchecked — it belongs in a real column.
- `review_sequence`, `is_canonical_for_boundary` — a reviewer can post more
  than one review comment against an identical `reviewed_head_sha` (observed:
  three `claude[bot]` reviews within 15 minutes on spark-api #111). The last
  completed review per `(reviewer_tool, boundary)` is canonical: its findings
  feed false-finding rate and corroboration. This is deliberately not the same
  attempt latency measures — latency uses the *first* completed review on the
  boundary (speed-to-signal), regardless of which one is canonical. Both stay
  in the ledger; each metric reads the row it needs.
- `non_completion_reason` — separates *why* an attempt didn't complete
  (`quota_exhausted`, `error`, `stale_superseded`, `policy_unavailable`,
  `context_unavailable`) from the `human-review` disposition it still resolves
  to. A capacity wall (Codex hit "usage limits have been reached" on spark-api
  #107/#108/#109 on 2026-08-15) is an operational fact, not a judgment failure,
  and coverage should be reportable both ways: coverage-if-capacity-available
  and coverage-as-observed.

**`reviewer-finding-ledger.csv`** adds:

- `reviewer_tool` — denormalized from the parent attempt for query
  convenience; must equal `attempt.reviewer_tool` for the row's `attempt_id`,
  **with no exception for a human-sourced finding.** A human finding attaches
  to a synthetic attempt row (`reviewer_tool=human`, `reviewer_identity` the
  maintainer's GitHub login, `reviewer_model`/timestamps not applicable) rather
  than being exempted from the invariant — every finding has a real parent
  attempt to reconcile against, and the validator enforces the equality
  uniformly instead of carving out `source=human`.
- `root_cause_key` — a short slug assigned during matching (see below) that
  groups every finding, from any reviewer or a human, addressing the same
  underlying defect. This is the join key for corroboration and uniqueness
  metrics; `matched_finding_id` alone cannot carry that weight once there are
  more than two reviewers.
- `match_method` — how the match was established: `same_file_same_line`,
  `same_file_diff_line` (code shifted between reviews), `cross_file_semantic`
  (same root cause, different call site), or blank for an unmatched finding.
- `match_confidence` — `high`/`medium`/`low` on the *proposed* match, separate
  from adjudication.
- `cross_reviewer_status` — `unique`, `corroborated`, `duplicate_confirmed`, or
  `duplicate_rejected`, or blank pending review. `unique` (no candidate match
  was proposed) is descriptive, not a judgment, and the matcher may set it
  directly. `corroborated` (a primary finding with at least one confirmed
  duplicate), `duplicate_confirmed`, and `duplicate_rejected` are judgments
  about a relationship between two findings and require the same maintainer
  sign-off as any other adjudication — never set these three from the
  matcher's proposal alone.

`adjudication` keeps its existing meaning (is the finding itself accurate:
`confirmed`, `false_finding`, `missed_issue`, `pre_existing`, `out_of_scope`).
`cross_reviewer_status` is an orthogonal axis — two reviewers can both flag the
same false positive, in which case the finding is `duplicate_confirmed` *and*
`false_finding`. Do not conflate the two columns.

## Matching procedure

1. **Scope.** After every reviewer's canonical attempt on a boundary has
   completed (or the boundary has moved), collect all findings across all
   `reviewer_tool` values for that PR whose evidence falls within the diff
   under review. Include findings from earlier boundaries on the same PR that
   were never marked fixed — a defect reported once and never remediated is
   still the same root cause when a second reviewer rediscovers it later (see
   `rc-proposal-race` in the worked example: found by Codex on one boundary,
   independently restated by Claude 11 days and two commits later).
2. **Candidate generation.** Bucket findings by same-file overlapping or
   nearby line ranges first (cheap, catches `same_file_same_line` and
   `same_file_diff_line`). For findings in different files, or with no
   line-range overlap, generate candidates from shared entities named in the
   summaries (table names, function names, column names) rather than running
   an all-pairs comparison.
3. **Semantic judgment.** For each candidate pair, a model answers one
   question: *do these two findings describe the same underlying defect, such
   that fixing one fixes the other?* This step may be performed by either
   reviewer's model or a third model — it does not matter which, because its
   output is a **proposal**, not an adjudication. Record `match_method` and
   `match_confidence` from this step.
4. **Mandatory human confirmation.** A maintainer reviews each proposed match
   and sets `cross_reviewer_status` to `duplicate_confirmed` or
   `duplicate_rejected`, with `adjudicated_by` a person, never a model — this
   extends the pilot's existing rule that "the model never adjudicates its own
   findings" to cross-reviewer matches, since a reviewer proposing a match
   involving its own finding is exactly the self-adjudication the original
   rule forbids.
5. **Assign `root_cause_key`.** The matcher assigns a proposed `root_cause_key`
   to a candidate cluster as soon as step 3 produces it — this is what lets a
   maintainer see the proposed grouping to confirm or reject in step 4, so the
   key exists before confirmation, not after. The earliest finding
   chronologically is the cluster's primary (`matched_finding_id` blank); later
   findings point `matched_finding_id` at it. If a maintainer rejects a
   proposed match (`duplicate_rejected`), split that finding into its own
   `root_cause_key` — a rejected match must not keep sharing the primary's key,
   since the column's own definition is "addressing the same underlying
   defect," which rejection specifically denies.

## Metrics this enables (extends the formulas in `reviewer-pilot.md`)

- **Per-reviewer and pooled**, reported separately, never only pooled:
  coverage, latency, false-finding rate.
- **Corroboration rate** — of confirmed root causes, the share independently
  found by more than one reviewer. A `root_cause_key` cluster counts as
  confirmed if **any** member's `adjudication` is `confirmed`, provided the
  cross-reviewer match itself is `duplicate_confirmed` — requiring every
  member separately re-confirmed is redundant once a maintainer has already
  agreed the findings describe the same defect; requiring only the primary's
  adjudication is arbitrary (chronological order isn't evidentiary weight). If
  every member of a cluster is `false_finding`, the cluster is not confirmed.
  High corroboration on the reviewers you already trust individually is weak
  evidence either could be dropped in isolation; it is not evidence that
  running both is redundant, since the worked example below shows
  non-overlapping catches even on an identical boundary.
- **Unique-catch rate per reviewer** — confirmed root causes found by exactly
  one reviewer. This is the number that would be lost by dropping a reviewer,
  and is the one a failover-only design (run reviewer A, fall back to B only
  on failure) cannot see, because B never runs when A succeeds.

## Worked example: spark-api PR #94

Both reviewers commented on the byte-identical `reviewed_head_sha`
(`d026baf24889ea75f5ec64bb3c150ebad490a0fd`) — Codex on 2026-08-04, Claude on
2026-08-15, eleven days apart, after `main` had advanced from
`e7994f63ec8b407a62fb3f0ed9c0767cf5ca9213` to
`bd7ec7c5aadeaa3a96f75a69bffa708b6fd177e5`. `merge_base_sha` did not change
(the branch never rebased), so per the existing staleness rule this stayed one
comparable boundary despite the base tip drifting — a case worth codifying
explicitly: **currency is a property of `merge_base_sha`, not of raw
`reviewed_base_sha` drift, for a branch that has not rebased.** Rows: `att-0001`
through `att-0003` in `reviewer-attempt-ledger.csv`, cohort `matcher_calibration`
(excluded from prospective/historical accuracy — this PR predates the current
policy and is being used only to validate the matcher, not to score either
reviewer).

Three **candidate** root causes — proposed matches, not yet maintainer-confirmed
(see below) — were found by both reviewers, in different words, at different
`file:line` anchors:

| root_cause_key | Codex anchor | Claude anchor | match_method |
|---|---|---|---|
| `rc-org-attribution` | `analytics.service.ts:79` | `analytics-event.handler.ts:84` | cross_file_semantic |
| `rc-legacy-fallback` | `wrapped-course.sql:20` | `wrapped-course.sql:34` | same_file_diff_line |
| `rc-proposal-race` | `analytics-event.handler.ts:582` (11 days earlier, different boundary) | `analytics-event.handler.ts:610` | same_file_diff_line |

Every anchor above was independently re-verified against GitHub's API
(`pull_request_review_id`-grouped inline comments) after an earlier pass of
this document cited several off-by-a-few-lines anchors — including one
"correction" that was itself still wrong. Re-check line numbers directly
against the API before trusting any citation in this document, including this
one.

None of these three would match on exact `file:line`. Two involve two distinct
call sites of the same design flaw, not the same line at all — a case that
requires the semantic step, not just a fuzzy line-range heuristic.

Three findings were unique to Claude's pass over the **identical boundary**
Codex had already reviewed: a 2x-weighting bug from ungrouped parallel-grader
rows (`rc-parallel-grader-2x-weight`), and two simplification-category
duplication call-outs. Codex's review of that exact commit did not surface
them. This is the concrete case for running both reviewers rather than a
failover chain: failover only invokes the second reviewer when the first is
unavailable, so these three would never have been caught.

`outcome` is `agent-clear` on all three attempt rows, despite each surfacing
real P2/P3 findings — `agent-clear` means no *major* (P0/P1) issue was
reported, not no issue at all. None of the nine findings in this worked
example reach P0/P1, so none block merge under the current taxonomy; the
finding rows remain fully visible for anyone who wants the P2/P3 detail. An
earlier pass of this document left `outcome` blank here, reasoning the
taxonomy had no value for this case — it does; the taxonomy already
distinguishes "major issue" from "issue," the earlier pass just applied it
incorrectly.

Full rows: `att-0001`–`att-0003` and `find-0001`–`find-0009` in the ledgers.
`find-0004`, `find-0005`, and `find-0006` each carry a `matched_finding_id`
pointing at their proposed primary (`find-0002`, `find-0003`, `find-0001`
respectively) with `match_method`/`match_confidence` filled in by the matching
procedure. Every `cross_reviewer_status` in this worked example is left blank
on purpose: no maintainer has reviewed these proposals yet, and this document
does not fabricate that sign-off. A maintainer must set
`cross_reviewer_status` and `adjudicated_by`/`adjudicated_at` on all six rows
before any of them count toward a corroboration or unique-catch metric.

## Recommended resolutions

These were judgment calls, not just bugs — a prior pass of this document left
them open. They now carry a recommendation, applied to this draft as the
working default. None of this is final: it needs the pilot owner's (Bennett's)
explicit confirmation before it governs real ledger rows, and any of it can be
overridden.

1. **"Confirmed root cause" for corroboration purposes** — resolved: any
   member confirmed (given the match itself is `duplicate_confirmed`) counts
   the cluster as confirmed. Applied in the Metrics section above.
2. **Does `blocker` require an automatic reviewer?** — resolved: yes. A purely
   human-caught P0/P1 already has a path — the attempt stays `agent-clear` and
   the finding is adjudicated `missed_issue`, which is exactly what miss-rate
   and the "no eligible `agent-clear` contains a human-found P0/P1" success
   gate exist to catch. Folding it into `blocker` would blur "what did
   automatic review contribute" with "was there a bug at all." `AGENTS.md` was
   reverted to match `reviewer-pilot.md`'s existing, stricter definition
   rather than left disagreeing.
3. **Does the taxonomy need a fourth value for open P2/P3s?** — resolved: no.
   `agent-clear` means no *major* issue, not no issue; it already covers an
   attempt with real P2/P3 findings and no P0/P1. The worked example's
   `outcome` cells now read `agent-clear` accordingly (see above) rather than
   blank.
4. **Historical cohort vs. the reviewer transition** — resolved: freeze the
   existing Codex-only historical cohort as legacy; do not build a parallel
   Claude historical cohort. Claude's review activity only began this week —
   there is no real multi-PR backlog to retroactively calibrate, and
   manufacturing one would be thin. Claude's calibration flows through the
   forward-looking prospective cohort instead, which is designed to run
   per-reviewer already. `reviewer-pilot.md`'s "Evaluation population" section
   states this explicitly now.
5. **Restructure the seed ledger for per-reviewer results?** — resolved: yes,
   applied. `reviewer-seed-ledger.csv` now has a `reviewer_tool` column; one
   seed produces one row per reviewer rather than one row total.
6. **Reconcile latency vs. canonical-attempt selection** — resolved: don't
   force them to the same row. Latency measures the *first* completed attempt
   on a boundary (speed-to-signal); `is_canonical_for_boundary` selects the
   *last* (most-refined judgment, feeds false-finding/corroboration). Both
   attempts stay in the ledger; different metrics read different rows. This
   was a documentation gap, not an actual conflict, once stated —
   `reviewer-pilot.md`'s latency formula and this document's schema-changes
   section both say so now.
7. **Is there a real Claude-equivalent to an auto-fix command?** — resolved:
   no, and the Codex side of the ban was itself imprecise. The actual observed
   Codex write-trigger (from its own review-footer text) is
   `"@codex address that feedback"`, not `@codex fix`. No Claude-equivalent
   trigger exists in this repo's history (only `@claude review` and
   `@claude review always` were ever observed). Both `reviewer-pilot.md` and
   `AGENTS.md` now name the correct Codex phrase and say plainly that no
   Claude equivalent currently exists, rather than implying a symmetric
   prohibition against a feature that isn't there.
8. **Is the added manual burden acceptable with no tooling?** — resolved:
   build the minimum tooling now rather than defer it. `scripts/
   validate_reviewer_ledgers.py` (new) checks column-count integrity, enum
   membership, cross-ledger references, and canonical-attempt uniqueness per
   boundary across all three ledgers. Run via `just validate-ledgers`.
   An earlier version of this bullet claimed the validator "would have caught"
   this document's first-draft `outcome`/taxonomy mismatch and the seed
   ledger's missing `reviewer_tool` column — that claim was checked by fault
   injection (editing scratch copies to reintroduce each bug) and found
   **false**: the script accepted a blank `outcome` on a completed attempt,
   and its seed-ledger column check was gated on having at least one data row,
   so it couldn't fire against the real, still-header-only ledger. Both gaps
   are now fixed — a completed attempt (no `non_completion_reason`) must have
   a non-blank `outcome`, and the seed ledger's column check runs
   unconditionally on the header — and re-verified by the same fault-injection
   method before trusting the claim again.
9. **Design for two reviewers or anticipate three or more?** — resolved:
   design for two now; don't build for three speculatively. Nothing in the
   current schema hard-codes a pair (`reviewer_tool` is an open column, not a
   fixed enum of exactly two — the validator only warns, never fails, on an
   unrecognized reviewer_tool), so there's no cost to deferring N-way matching
   complexity until a third reviewer is actually added.

10. **`agent-clear` is defined boundary-level but stored attempt-level, and
    this draft does not resolve that.** `reviewer-pilot.md`'s taxonomy defines
    `agent-clear` as "**every** automatic reviewer configured for the
    repository reports no major issue" — a PR-level, all-reviewers judgment.
    But `outcome` is a column on a per-`(reviewer_tool, boundary)` attempt
    row, and the worked example stamps `agent-clear` on `att-0001`–`att-0003`
    individually, one reviewer at a time. That reads correctly here only
    because both reviewers happened to agree; nothing in the schema computes
    or stores the actual PR-level aggregate, and attempt rows are immutable
    ("reruns get new attempt IDs; findings are never overwritten"), so there's
    no defined answer for what happens to an already-recorded `agent-clear`
    attempt if a second reviewer's later attempt on the identical boundary
    finds a P0. **Recommendation, not yet applied — this needs the pilot
    owner's decision before it's load-bearing:** keep `outcome=agent-clear` on
    an attempt row meaning only "this one reviewer, alone, found no major
    issue on this boundary," and treat the true PR-level disposition
    `AGENTS.md`'s merge-readiness section describes (every configured reviewer
    clear) as a separately computed, currently-manual judgment a maintainer
    makes by reading every reviewer's attempt for the boundary — not
    something any single attempt row's `outcome` value can answer alone. If
    that's not the right call, the alternative is renaming the attempt-level
    value (e.g. `reviewer-clear`) to stop reusing `agent-clear` for two
    different scopes — a larger change to existing pilot vocabulary that
    shouldn't happen without sign-off.

Separately: adding a second standing reviewer is itself a change to "models,
automatic-review settings, policy, taxonomy, or metrics" under the existing
rule in `reviewer-pilot.md`, which means it starts a new `evaluation_version`.
This document still does not assign that version string (e.g.
`v2-multi-reviewer`) — that naming belongs to whoever owns the pilot's
evaluation calendar.
