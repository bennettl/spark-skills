---
name: skills-audit
description: >-
  Audit this skills registry itself for rot — run it on a cadence, before a
  release, and after any major model release. A skill can be perfectly
  well-formed and quietly wrong: it names a file that was renamed, states a count
  that was true last month, duplicates a rule another skill also owns so the two
  drift, delegates to a sibling skill whose input contract doesn't accept what it
  passes, or references a model that no longer exists. `scripts/audit.py` covers
  the mechanical half (dead app-repo paths, expiring hardcoded counts, reference
  and cross-skill integrity, ownership overlap); this skill runs it, then does the
  parts a script cannot — verifying model currency against a LIVE source rather
  than a baked-in roster, reviewing whether delegating skills and their targets
  actually have compatible input contracts, and checking whether two skills'
  descriptions overlap enough that the wrong one fires. Reports findings with
  file:line and a fix direction. It audits and recommends; it does not rewrite
  the skills.
metadata:
  supaclass-repos: [spark-api, spark-web]
  maturity: vertical-slice
---

# skills-audit

The registry's own gate. `validate.py` asks *"is this a well-formed skill?"* —
frontmatter, name, line budget, symlinks. That check passes on a skill that is
confidently, silently wrong. This asks *"is it still true, and does it still
cohere?"*

Every check here exists because of a defect that shipped or nearly did:

- `diagnose` cited `docs/credit-reservation.md`; the file is
  `credit-reservation-system.md`. A dead path reads as verified.
- `dual-repo-review` cited `scripts/setup-queue.sh` as an established convention;
  it exists only on an unmerged branch.
- `dual-repo-review` delegated to `self-review` "inside each checkout", but
  `self-review` had no repo-root input — from a third directory it detected
  "neither" and degraded to near-nothing, silently.
- Three files hardcode "~55 of ~62 controllers." Correct today. Wrong the moment
  the next controller merges.

## When this fires

- **On a cadence** — monthly, or whenever the app repos have moved noticeably.
- **After any major model release** — the trigger `meta/model-currency.md` names.
- **Before adding the Nth skill**, when you want to know whether the existing set
  still coheres.
- **After a rename or refactor in spark-api / spark-web** — that's when path and
  symbol claims go stale in bulk.

Not a per-PR gate: `validate.py` plus the author's own verification covers that.
This is the periodic sweep.

## Method

1. **Run the mechanical half.** `python3 scripts/audit.py` (or `just audit`; `just
   check` runs validate + audit). It reports:
   - **dead app-repo paths** — every backticked `src/…`, `libs/…`, `docs/…` path a
     skill names, checked against both sibling checkouts;
   - **expiring counts** — `~55 of ~62`, `~65 modules`, and similar, which are
     accurate when written and rot on the next merge;
   - **reference integrity** — a `SKILL.md` citing a `references/` file that
     doesn't exist, or a reference file nothing cites;
   - **cross-skill references** — delegating to a skill not in the registry;
   - **ownership overlap** — one stack fact independently authored in N skills.

   Read the output as a **worklist, not a verdict.** An expiring-count warning
   means *re-verify*, not *wrong* — go count, and most of the time it still holds.

   **A clean run is not proof of correctness.** The script's known false-negative
   surface is documented in its docstring and is wide: it only inspects
   *backticked* tokens, only checks paths beginning with a known root (so bare
   filenames like `app.module.ts` are unverified), accepts a path found in
   *either* repo, and cannot evaluate prose claims at all. Steps 2–5 exist
   precisely because step 1 cannot see those.

2. **Verify model currency against a live source.** This is the half a script must
   not fake. Per `meta/model-currency.md`, do **not** compare against a hardcoded
   roster — that list is the thing that goes stale, and it has already burned this
   registry once. Instead fetch ground truth at run time (the Claude models
   endpoint, e.g. `client.models.list()`, or the current models-overview doc), then:
   - flag any skill referencing a model the live set marks deprecated or retired;
   - confirm the registry's own defaults and examples name models still served;
   - surface newly-released models the registry hasn't accounted for.
   `validate.py` greps for known-stale ID patterns, which catches yesterday's
   problem; only a live query catches tomorrow's.

3. **Review delegation contracts** — the check a script can only partly do. For
   every place skill A tells the model to invoke skill B, open B and confirm its
   **Inputs** section actually accepts what A passes. The failure mode is not a
   crash; it's B silently falling back to a default and producing a weaker result
   that still looks complete. Ask specifically:
   - Does B take an explicit target (repo root, endpoint, scope), or does it infer
     one from the working directory?
   - If it infers, what happens when A invokes it from a *third* directory — this
     registry, say? Does B report that it degraded, or does it just degrade?
   - Do sibling spokes have **consistent** interfaces? Divergence here is the root
     cause: `api-contract-check` accepted explicit repo roots while `self-review`
     did not, and the orchestrator was built against the wrong one.

4. **Review trigger overlap.** Both Claude Code and Codex select a skill by
   matching its `description`. Read the descriptions side by side and ask which
   one fires for a realistic prompt when several are plausible. Several review
   skills legitimately claim "run before a PR" — that's expected. The question is
   whether the intended one wins, and whether the hub-and-spoke relationships are
   stated clearly enough in each description that a delegating skill isn't
   mistaken for a peer.

5. **Spot-check the claims a script can't parse.** Prose assertions about behavior
   — "the pipe has no `transform`", "there is no global `APP_GUARD`", "zod never
   validates responses." Pick the load-bearing ones and re-verify against source.
   These are the highest-value and lowest-frequency checks: they rarely change,
   and when they do, several skills become wrong at once.

6. **Report.** Findings with `file:line`, a severity, and a fix direction, per
   `references/report-template.md`. Group mechanical findings (from the script)
   separately from judgment findings, so it's obvious which are reproducible.

## Guardrails

- **Audit; don't rewrite.** Report the finding and the fix direction. Editing a
  skill to satisfy the audit is a separate, reviewable change — especially
  ownership consolidation, which is an architecture decision, not a lint fix.
- **Never hardcode the "current" model set.** The one rule
  `meta/model-currency.md` is emphatic about. A roster baked into this skill is
  stale the moment a model ships, and it will report confidently wrong results.
- **An expiring count is a prompt to verify, not a defect.** Re-count before
  reporting. Most survive. Reporting accurate facts as errors trains people to
  ignore the tool.
- **Allowlist deliberately, not reflexively.** `meta/audit-allow.txt` exists for
  paths cited on purpose while absent (an unmerged branch, a worked example).
  Every entry is a promise that the absence is intentional — review them, and
  delete an entry when the referencing text changes. An allowlist that only grows
  is a suppressed check.
- **Duplication is not automatically a bug.** Skills must be self-contained: both
  tools load only the invoked skill's `references/`, so a shared facts file
  outside the skill directory wouldn't reliably load. The fix for overlap is
  usually a **declared owner and a tie-break** ("if these disagree, X wins"), not
  consolidation.
- **Scope to the registry.** Auditing the app repos' code is `self-review`'s and
  `authz-audit`'s job. This skill audits the skills.

## References

- `references/report-template.md` — output shape: mechanical vs judgment findings,
  severity, fix direction.
- `meta/model-currency.md` — why the live check must query a live source, and the
  Opus 5 incident that motivated it.
- `meta/audit-allow.txt` — deliberately-absent paths and their reasons.
