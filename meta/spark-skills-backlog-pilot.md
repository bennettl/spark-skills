# spark-skills backlog review pilot

This is a lower-stakes calibration of reviewer mechanics and dev-operations
judgment. It does not count toward the application-repository accuracy cohort in
`reviewer-pilot.md` and cannot validate app-specific authorization, schema,
contract, or cache rules.

The recorded run below (PRs #6-9, initiated 2026-08-13) used Codex only,
predating Claude's addition as a second standing automatic reviewer — its
ledger rows should not be read as having tested multi-reviewer agreement. Any
further round on this backlog should follow the multi-reviewer procedure in
[`reviewer-pilot.md`](reviewer-pilot.md) and
[`multi-reviewer-matching.md`](multi-reviewer-matching.md) instead of the
single-reviewer steps below.

## What this tests

- automatic and manual GitHub review delivery;
- exact base/head handling for stacked pull requests;
- detection of broken skill contracts, stale claims, unsafe helpers, and
  distribution drift;
- useful separation of `agent-clear`, `blocker`, and `human-review`;
- agreement between Codex and an independent maintainer judgment.

GitHub `@codex review` follows the root `AGENTS.md`; it does not automatically
execute the interactive skills stored under `.agents/skills/`. The deterministic
`Registry` check and maintainer adjudication remain separate evidence.

## Initial backlog and order

The initial calibration set is the four PRs returned on 2026-08-13 by
`repo:bennettl/spark-skills is:pr is:open created:<2026-08-13`. Preserve its two
stacks and process each predecessor before its successor:

1. #6 dual-repository review skill, then #7 skills-audit;
2. #8 browser-drive skill, then #9 browser-drive review fixes.

Record the query and each eligibility decision in the attempt ledger. Branch
heads may change during conflict resolution; the immutable reviewed SHAs are the
audit identity.

## Procedure

1. Rebase each stack root onto current `main` with semantic conflict resolution.
   Rebase/retarget its successor without flattening the intended diff.
2. Confirm the PR is non-draft, conflict-free, and its template names the actual
   predecessor, successor, assumptions, and merge/install order.
3. Wait for `Registry` on the current head. A missing or failing check prevents
   `agent-clear`.
4. For an already-open PR, comment `@codex review` after the final rebase. For a
   newly opened PR, first observe the configured automatic review. Record trigger
   type, base SHA, merge base, head SHA, review commit, and timestamps.
5. A maintainer independently records material findings before reading Codex's
   disposition, then adjudicates matches, misses, and false findings in the
   normalized ledgers.
6. Re-run review after any head or base movement. Never carry a clear result
   forward across a changed effective diff.

## Disposition

- **agent-clear:** current boundary; conflict-free; `Registry` passes; stack order
  is satisfied; no unresolved P0/P1; no mandatory human trust-boundary review.
- **blocker:** a confirmed P0/P1 must be fixed before progressing the stack.
- **human-review:** stale/incomplete review, missing context, or changes involving
  credentials/sessions, browser/process/filesystem control, distribution/install,
  CI/reviewer policy, or equivalent judgment-heavy behavior.

Codex never merges during this pilot. `agent-clear` means ready for the designated
human's final merge decision, not permission for automation to press merge.

## Graduation check

Complete the backlog calibration only when every PR was reviewed on its final
boundary, deterministic validation passed, conflicts and stack order were
resolved, and the maintainer/Codex comparison was recorded. Any missed P0/P1 or
unsafe `agent-clear` requires a policy revision and a fresh calibration version.
