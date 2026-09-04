---
name: grading-eval
description: >-
  Score a grading-pipeline change in spark-api against the golden grading
  benchmarks before it merges. Use it whenever a diff touches how scanned exams
  are read or scored: grading or transcription prompts under src/llm/task, the
  grading strategies or consensus logic under src/grading, SubmissionConverter
  scoring, the model registry in llm.const.ts, page rendering or orientation in
  spark-serverless, or a proposal to change a default grading seat. Also use it
  for "does this model or prompt read bubble sheets better", "does read-first
  help on handwritten work", or "is this change safe for Nathan's exams". Two
  harnesses: evals/mc-sheets (124 answer sheets, golden letters) and
  evals/written-response (252 mixed papers, instructor-verified points). It
  restores the datasets from S3, runs the variants the diff affects, compares
  them to the production baseline and best seats, and reports accuracy,
  invariants and item-level regressions. It measures; it does not decide.
metadata:
  supaclass-repos: [spark-api, spark-serverless]
  maturity: vertical-slice
---

# grading-eval

In May 2026 the grading pipeline awarded the wrong points on 8% of 3,868
multiple-choice items across six real exams, and every self-check read green.
The instructor found it by hand. This skill exists so that never happens
silently again: any change to how exams are read or scored is measured against
real papers with verified labels before it ships.

Both harnesses run the **real** `LlmService` (same providers, prompts, schemas,
activity logging) from a minimal Nest context against the local database, so
what gets scored is the code that will run in production, not a
re-implementation. Both live in `spark-api/evals/`; each has a `README.md`
(variant grammar, metric definitions) and a `RUNBOOK.md` (commands, setup,
recording results). Those two files are the source of truth; this skill says
which to run, how to read it, and what to write down.

| harness | data | truth | headline metric |
|---|---|---|---|
| `evals/mc-sheets` | 6 Spring 2026 physics finals, 124 answer sheets, 3,868 items | golden letters (three key-blind readers + human review; reproduced the instructor's manual count) | `awardAcc` |
| `evals/written-response` | 6 Spring 2026 physics midterms, 252 papers, 71 free-response questions (3,084 items) + 63 MC | instructor CSV in `written/ground_truth/` (precedence over prod overrides and closed regrades). **Production scores are not truth** here | `withinTol` on `--type fr` |

Both datasets hold student names and scans. They live at
`s3://prod-spark-content/evals/mc-answer-sheets-spring-2026/` (`data/` for MC,
`written/` for free-response, `tools/` for the Python that built them) and are
restored to a directory outside every repository (`EVAL_DATA_ROOT`). Never
commit them, never paste their contents into a PR. Prod credentials come from
`heroku config:get` in a subshell; never echo them.

## When this fires

- A diff in `spark-api` touches `src/llm/task/**` (prompts or schemas used for
  grading or transcription), `src/grading/**`, `src/assignment/converter/**`,
  or `src/llm/const/llm.const.ts`.
- A diff in `spark-serverless` changes how pages are rendered, split, or
  oriented.
- Someone wants to add, remove, or re-default a grading seat model.
- Someone asks how accurate grading is, whether a model reads bubble sheets
  well, or whether transcribe-then-grade beats one-shot grading on handwriting.

Do not use it to review code quality (`self-review`) or to find a bug from a
symptom (`diagnose`). It answers one question: did this change make grading
more or less correct on the benchmark, and by how much.

## Which harness

- Objective-only change (letter reading, MC scoring, key handling, orientation
  of bubble sheets): `mc-sheets`.
- Rubric grading, the grader prompt, consensus/adjudication, transcription of
  handwriting, or anything a mixed exam exercises: `written-response`, and
  `mc-sheets` too if the change can reach the objective path (the production
  grader sees the whole paper; the MC items inside the midterms are scored by
  `written-response` as well, use `--type mc` to see them).
- A model or seat-default proposal: both.

## Inputs

- **The change under test**: a branch or working tree of `spark-api`.
- **The datasets** restored under `EVAL_DATA_ROOT` (`data/` and `written/`).
- **Local Postgres** running (`docker compose up db`) and provider keys in the
  repo `.env`. `EVAL_PRINCIPAL_ID` must be a `users.id` in the local database.
- For `written-response`: whatever instructor CSVs exist in
  `written/ground_truth/`. Run `report.ts --truth` first and state how many
  labeled items the conclusion rests on. With none, only the label-free
  metrics (consistency with production, legibility flags, two-seat agreement)
  are meaningful, and the report says so.

## Procedure

1. **Pick variants that isolate the change.** The grammar is
   `<mode>:<input>:<model>` in both harnesses. To test a prompt or strategy
   change, run the variant that exercises it and compare to the cached results
   in `results/` (the last known state of `main`), re-running with `--force`
   when the prompt itself changed. To test a new model, run
   `keyblind:upright:<model>` (MC) and `prod:upright:<model>` plus
   `transcribe:upright:<model>` (written). To test read-first grading, run
   `twostep:upright:<reader>+<grader>` next to `prod:upright:<grader>`. To test
   rendering, compare `pdf`, `raw` and `upright` for one strong model.
2. **Run on the full set** unless iterating on a prompt, in which case
   `--exam 2530A --limit 20` (MC, hardest layout) or `--labeled --exam 1510M1`
   (written) is a fast first signal. Never draw a conclusion from fewer than the
   full labeled set.
3. **Report against the anchors.** MC: `report.ts` always prints the
   production as-graded row (92.05%) and the cached best readers (Sonnet 5
   calibrated 99.95%, GPT-5.6 99.97%). Written: the `PROD as-graded` row and
   the best cached variant, on `--type fr`. State the change's numbers next to
   those, per exam when a layout matters.
4. **Explain every regression at item level** with `--detail <variant>`. A
   changed award on a genuinely ambiguous mark, or inside tolerance on a
   derivation, is not a regression; a changed award on a clean mark or outside
   tolerance is. The MC golden set's `status` field and the audit report record
   how the ambiguous ones were judged; the written CSV's `note` column holds
   the instructor's reasoning.
5. **Check the invariants**, not only the headline.
   MC: `keyEcho` 0, `wrong=key` 0 (a misread that equals the key is the
   signature of answer-key leakage into the reading step), the two rotated
   sheets score 14/30 and 103/106, `flagged` under about 1% for a proposed
   default reader.
   Written: `err` 0, `notClear` under about 5% and genuinely hard to read when
   spot-checked, `over` and `under` roughly balanced (a one-directional bias is
   a prompt problem, not a seat problem).
6. **Two-seat view when seats are involved.** MC: `tools/pair_agreement.py`
   for the proposed anchor and challenger. Written: `report.ts --agree a,b`.
   The numbers that matter are accuracy when both agree and the escalation
   rate. Same-provider pairs are expected to agree more and be right less; say
   so if one is proposed.
7. **Record.** Append the report output to the archive's `reports/` (MC) or
   `written/reports/` (written), then `aws s3 sync` `results/` and reports back
   so the next person starts from your run. If you produced or received new
   ground truth, sync `written/ground_truth/` first: it is the most expensive
   artifact in the archive.

## Judgment calls

- The MC golden labels came from three independent key-blind model readings
  with human review of disagreements, and reproduced the instructor's manual
  error count. Treat them as authoritative until the instructor's own CSV
  replaces them; when it does, keep the model-derived file for comparison and
  re-score everything once.
- Written-response truth is the instructor's points, full stop. Do not promote
  a variant on "vsProd" agreement alone; the production scores it agrees with
  were never verified. If the labeled set is small, say how small and treat
  the result as directional.
- Cost and latency are reported but are not pass/fail criteria here; they are
  inputs to the seat-default decision, which belongs to the product owner.
- A model that is excellent on the square-box layouts and weak on the
  circle-bubble layout (every Gemini model tested so far) is a fine challenger
  or third reader and a poor default anchor. Say which role the numbers
  support.
- If the harness itself needs a change to test the diff (a new mode, a new
  input kind), make that change in the harness in the same PR and keep every
  existing variant name working, so cached results stay comparable.
- Need more labeled data? `tools/written_labeling_packet.py` in the archive
  writes per-exam CSVs pre-filled with everything except `instructor_points`,
  plus a 48-paper stratified sample. Send the sample first; a full exam is
  hours of an instructor's time.

## Output

A short table of the variants run against the anchors (per harness), the
invariant checklist, item-level notes for every regression, the size of the
labeled set the conclusion rests on, and one sentence saying whether the
benchmark supports the change. Link the archived report files.
