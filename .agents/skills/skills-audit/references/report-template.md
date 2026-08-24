# Report template

Separate **mechanical** findings (reproducible — `scripts/audit.py` produces them
identically for anyone) from **judgment** findings (a human or model concluded
this). A reader must be able to tell which is which.

---

## Skills audit — <date> · <n> skills

**Mechanical:** `scripts/audit.py` → `<n>` error(s), `<n>` warning(s)
**App repos:** spark-api @ `<sha>` · spark-web @ `<sha>` *(say if either is absent —
path checks are skipped for a missing repo, not passed)*
**Model currency:** `<live source queried>` — say which, and when

If either app repo is absent or the live model source is unavailable, stop the
healthy/action-required classification and report **Incomplete / human-review
required** with the missing dependency. Deferred checks are not passes.

### 1. Mechanical findings

Paste the script's own output or summarize it. Do not re-word warnings — they're
reproducible and should stay greppable.

| file:line | kind | finding | action |
|---|---|---|---|
| `api-contract-check/SKILL.md:60` | expiring count | `~55 of ~62` | re-counted: **55/62, still accurate.** No change. |
| `diagnose/references/localization.md:132` | expiring count | `only ~5 *.spec.ts` | re-counted: **5, accurate.** No change. |
| `dual-repo-review/…/seam-inventory.md:73` | dead path | `src/process-insight/enum.ts` | allowlisted — lands with spark-api#85 |

**Re-verify before reporting.** An expiring count that still holds is a *clean*
result, and saying so is the useful output. Reporting accurate facts as defects
trains people to ignore the tool.

### 2. Model currency

State the live source and the date. Never compare against a hardcoded roster.

> Queried the live model list on `<date>`. No skill references a deprecated or
> retired model. `validate.py`'s stale-ID lint is clean. One newly-released model
> the registry hasn't accounted for: `<name>` — no action needed, the skills
> don't pin model IDs.

If a skill *does* name a retired model, that's a **blocker**: it will produce
failing calls.

### 3. Delegation contracts

For each A → B delegation, whether B's Inputs accept what A passes.

| A → B | compatible? | note |
|---|---|---|
| `dual-repo-review` → `self-review` | ✅ | B accepts an explicit repo root (added after this check found it didn't) |
| `dual-repo-review` → `api-contract-check` | ✅ | B accepts overrides for both repo roots |
| `self-review` → `api-contract-check` | ✅ | hands off endpoint scope |

The failure to look for is **silent degradation**: B falls back to a default and
returns something that looks complete. Note whether B *announces* the fallback.

### 4. Trigger overlap

> Four skills reference pre-PR review. `self-review` is the hub; `api-contract-check`
> and `dual-repo-review` state their delegating relationship in their descriptions,
> so a prompt like "review my branch" should land on `self-review`. **No change.**

Flag it when two descriptions are close enough that the wrong one plausibly wins.

### 5. Judgment findings

Anything the script can't reach — prose claims re-verified against source,
architectural drift, ownership decisions.

| # | sev | finding | fix direction |
|---|---|---|---|
| 1 | medium | `res.data.data` envelope depth authored in 4 skills, no declared owner | name `api-contract-check` the owner; add a tie-break line to the other three |

### Verdict

> **Registry healthy.** 6 mechanical warnings, all re-verified as currently
> accurate; 1 judgment finding (ownership overlap on envelope depth) carried as a
> follow-up. No dead paths, no retired models, no broken delegations.

or

> **Action required.** `<skill>` references a retired model (blocker) and
> `<skill>` delegates to `<skill>` with an incompatible input contract (high).

or

> **Incomplete / human-review required.** `<missing sibling checkout or live
> model source>` prevented required evidence from being collected. No healthy
> verdict until the audit reruns with that dependency available.

### Allowlist review

`meta/audit-allow.txt` is a suppressed check — review it every run, don't let it
accumulate.

| entry | still justified? |
|---|---|
| `scripts/setup-queue.sh` | yes — spark-api#85 still open |
| `src/process-insight/` | **no — #85 merged; remove the entry and re-run** |
