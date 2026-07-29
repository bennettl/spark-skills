---
name: diagnose
description: >-
  Root-cause a bug in the Supaclass app repos (spark-api, spark-web) from a
  symptom — a screenshot of broken UI, an error or stack trace, a failing
  request, or a description of wrong behavior. Use it when something is
  observably wrong and the cause is not yet known: blank or undefined data, stale
  data after an action, a 401/redirect loop, wrong numbers or dates, a validation
  or 500 on write, a missing column after deploy, async work (grading, PDF, SQS)
  that never ran, or a component that renders wrong. Classifies the symptom
  against this stack's silent-failure modes (envelope depth, hand-written type
  drift with no runtime validation, opt-in ResponseInterceptor, per-route guards,
  synchronize:true schema mutations, numeric/timestamptz serialization),
  localizes the responsible code, then confirms or refutes each hypothesis by
  reading it. Emits a root cause with file:line evidence, a confidence level, and
  a ranked fix plan. It diagnoses and plans; it does not apply the fix.
metadata:
  supaclass-repos: [spark-api, spark-web]
  maturity: vertical-slice
---

# diagnose

A bug in this stack usually does **not** announce itself where it happens. There
is no runtime validation at the API boundary — spark-web's types are hand-written
with no codegen, and zod is present but never validates responses (`.parse`/
`.safeParse` appear nowhere in `src/api`). So a backend field rename produces
`undefined` three components downstream, with no error anywhere near the cause.
Same for a missing `ResponseInterceptor`, a wrong envelope depth, or a `numeric`
column arriving as a string.

That makes generic debugging weak here and a stack-specific candidate list
strong. This skill turns a symptom into a **confirmed** root cause plus a fix
plan. It reads code to prove the cause; it does not guess, and it does not patch.

## When this fires

Invoke it when something is observably wrong and you don't yet know why:

- a **screenshot** of broken UI (the common case — blank panel, wrong value, error toast);
- an error message, stack trace, Sentry issue, or failing network request;
- a prose report ("grading never finishes", "the roster shows stale counts");
- a test or manual step that fails for an unclear reason.

Do **not** use it when the cause is already known and only the fix is in question,
or to review a diff you just wrote — that's `self-review`. If the symptom is
specifically a field mismatch you've already localized to one endpoint, go
straight to `api-contract-check`.

## Inputs

- **The symptom, in whatever form you have it.** A screenshot is enough to start.
  Read it for: the route/URL, which component is wrong, whether it's *blank* vs
  *error* vs *wrong value*, any toast text (a Mantine toast usually means
  `handleMutationError` fired from an `ApiError`), and any visible devtools panel.
- **The repos.** Most diagnoses need both `spark-api` and `spark-web`; they're
  sibling checkouts. Detect which are present. With only one, say so and scope the
  conclusion — never assert a cross-repo root cause you couldn't read both sides of.
- **What you should ask for when the symptom is ambiguous.** The two highest-value
  follow-ups are the **Network tab** (actual request URL, status, response body)
  and the **browser console**. Ask for one of those rather than guessing between
  candidates that a single request would separate. Ask once, with a specific
  request; don't interrogate.

## Method

1. **Classify the symptom.** Match it to a symptom class in
   `references/symptom-map.md`, which lists each class's candidate causes ranked
   by how often this stack produces them. Don't skip to a favorite hypothesis —
   read the class's full candidate list first, because several of these symptoms
   are produced by more than one cause and they need different fixes.

2. **Localize the responsible code.** Traverse from the symptom to the code that
   owns it using `references/localization.md` — the concrete path for this
   codebase (URL → `routing/` `RoutePaths` → `pages/<feature>/` → component →
   `src/api/<resource>.ts` → `Endpoint`/`QueryKey` → controller → service →
   entity). Name the files before theorizing about them.

3. **State hypotheses as falsifiable claims.** For each candidate: what must be
   true in the code for this to be the cause, and what would disprove it. Rank by
   prior likelihood from the symptom map, not by what's easiest to check.

4. **Confirm or refute by reading the code.** This is the step that matters. Open
   the files and check. Every hypothesis ends as **confirmed** (with file:line
   evidence), **refuted** (with the line that rules it out), or **unresolved**
   (with what you'd need — a log, a network capture, a DB query). A plausible
   story with no file:line behind it is a hypothesis, not a root cause, and must
   be labeled that way.

5. **Hand off contract drift — do not re-derive it.** If the cause is an FE↔BE
   field mismatch, the authoritative check is **`api-contract-check`**. Confirm
   enough to establish that drift *is* the cause, then hand it the endpoint as
   scope rather than field-by-field diffing the whole shape here.

6. **Report** per `references/report-template.md`: the symptom, the confirmed root
   cause with evidence, refuted candidates (so the next person doesn't re-walk
   them), a **ranked fix plan**, and how to verify the fix. If nothing is
   confirmed, say so plainly and give the single next diagnostic step — an
   unconfirmed diagnosis stated confidently is the worst output this skill can
   produce.

## Guardrails (the Supaclass-specific judgment)

- **Evidence or it's a hypothesis.** Label every conclusion `confirmed` /
  `likely` / `unresolved`. This stack's failure modes are silent and several look
  identical from the UI; confident guessing sends the author down the wrong path
  and costs more than saying "I need the network response."
- **Diagnose and plan; don't patch.** Output a fix plan with tradeoffs, ranked,
  minimal-first. The author applies it and re-runs. (Offer to implement as an
  explicit next step — don't fold it into the diagnosis.)
- **Trust the entity and the class-validator DTO over TypeScript.** spark-api runs
  with `strictNullChecks: false` and `noImplicitAny: false`; declared and inferred
  types can lie. The DTO decorators are the request contract; the returned entity
  is the response contract. (spark-web is strict-on — different footguns.)
- **`synchronize: true` means any entity fix is a live schema mutation.** Never
  propose an `@Column`/entity change as a casual fix. Spell out the migration
  consequence, whether it's destructive (a rename is a drop + add), and whether a
  `scripts/*.sql` or `onetime/*` backfill is required. If a non-entity fix exists,
  rank it first.
- **Don't reflexively prescribe response validation.** "Add zod `.parse` at the
  boundary" is a real systemic improvement but it is absent across ~65 api modules
  by convention; adding it in one module is inconsistent, not a fix. Fix the
  actual drift, and note validation once as a systemic follow-up.
- **Fix the bug, not the architecture.** Recommend the smallest change that
  resolves the confirmed cause and matches surrounding convention. If the bug is
  an instance of a recurring class, note that once as a follow-up — don't expand
  the diagnosis into a refactor proposal.
- **Never print secret values.** Both repos have known committed-credential
  problems (a GCP service-account key in spark-api, a git-tracked `.env` in
  spark-web). If a diagnosis touches them, reference the file, never the value,
  and don't re-litigate the known issue as a new finding.
- **Never hardcode model IDs or context windows** in findings or examples. Where
  the grading/LLM path is implicated, refer to the config or service value that
  selects the model. See `meta/model-currency.md`.

## References

- `references/symptom-map.md` — symptom classes → ranked candidate causes, each
  with what to check and what rules it out. The core of the skill.
- `references/localization.md` — how to get from a screenshot or URL to the
  responsible file in each repo, including the async/SQS paths.
- `references/report-template.md` — the output shape: evidence table, confidence
  labels, ranked fix plan, verification step.
