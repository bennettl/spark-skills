---
name: self-review
description: >-
  Pre-PR self-review gate for the Supaclass app repos (spark-api, spark-web).
  It complements build CI and human review. Reviews the working diff against
  the actual pull-request base, requires human review when that base is unknown,
  auto-detects the repo, and loads its AGENTS.md review rules. Checks spark-api
  DTO validation, synchronize:true schema risk, response envelopes, entity
  exposure, secrets, and route guards; checks spark-web endpoint/query-key use,
  cache invalidation, mutation errors, query gating, and Mantine conventions.
  Contract changes hand off to api-contract-check. Emits file:line findings with
  severity and a merge, do-not-merge, or incomplete/human-review verdict; it
  does not rewrite.
metadata:
  supaclass-repos: [spark-api, spark-web]
  maturity: vertical-slice
---

# self-review

Both app repos have build CI, but neither has git hooks and their lint/test
coverage remains incomplete. This skill is a pre-PR judgment gate run by the
author on their own branch; it complements deterministic CI and human review.
It scopes to what actually changed, applies the checks the repo's `AGENTS.md`
calls highest-value, and returns a blunt **merge / do-not-merge / incomplete**
verdict with file:line findings. It is a review, not a rewrite: it tells you what
to fix, it does not fix it.

## When this fires

Run it on a feature branch **before opening a PR**, and again after addressing
findings. Skip it for a no-op branch (docs-only, a `.md` tweak) — say so and
stop. If unsure, run it: build CI does not cover the security, data, and
cross-repository failure modes checked here.

## Inputs

- **The branch diff and actual base.** Review only the changed files, not the
  whole repo. Establish the review base in this order: a caller-supplied base
  ref/SHA; the open PR's base from metadata; or — for a pre-PR run with
  neither — the branch's intended base (its tracked upstream, else `main`),
  reported explicitly as an **author-declared base**. Never silently
  substitute `main` when the branch shows stacking evidence (history built on
  another feature branch, or the author names a different predecessor): there,
  and whenever no base can be established at all, return an
  **incomplete / human-review required** result instead of a merge verdict.
  Compute the merge base between the established base and `HEAD`, then inspect
  the three-dot committed diff plus `git status` and relevant uncommitted
  hunks.
- **The repo.** Auto-detect which repo you're in (see Method 2) and load its
  rule set. The `references/*-checks.md` files in this skill are the **source of
  truth** for the checklists; the repo's `AGENTS.md` "Code Review Rules" +
  "Non-obvious rules" are the confirmatory, possibly-newer overlay. Read
  `AGENTS.md` when present and let it override; **degrade gracefully** when it's
  absent by falling back to the reference checklist — never to "no checks."
- **Nothing else.** No ticket, no PR description. Review the source that
  changed.

## Method

1. **Get the diff.** Resolve the actual PR base ref/SHA as described above,
   compute its merge base with `HEAD`, and collect the changed file list + hunks
   (committed and uncommitted). Group by area (controller, entity, dto, api
   module, component, …) so checks map cleanly. State the exact base and head in
   the report. An unknown or moving base is not clearance.

2. **Detect the repo** from files at the root, not from the directory name:
   - **spark-api** — `nest-cli.json`, `@nestjs/core` in `package.json`, and the
     `src/<feature>/{controller,service,entity,dto}` module layout.
   - **spark-web** — `vite.config.ts` + `src/api/const.ts`, `react` + `@mantine/*`
     in `package.json`.
   - **neither** — no match. Run only the stack-neutral checks (added secrets,
     sensitive or behavior-changing debug output, obvious footguns), state that
     repo-specific rules were unavailable, and keep the verdict scoped to what
     you could check.

3. **Load the rule set.** Open this skill's matching `references/<repo>-checks.md`
   and, if present, the repo's `AGENTS.md`. Reconcile: reference checklist as the
   spine, `AGENTS.md` as the authority where they differ.

4. **Run the checks** against the changed hunks — full checklists in the
   references. In brief:
   - **spark-api** (`references/spark-api-checks.md`): DTOs are **classes with
     class-validator decorators** (not bare interfaces); any `@Column`/entity
     edit is a **live `synchronize: true` schema change** (flag renames/drops/
     type-narrowing/nullability + data-loss risk); **new controllers carry
     `@UseInterceptors(ResponseInterceptor)`**; **no leaked entity fields**
     (there is no serializer — a returned entity ships every column); new routes
     are **guarded** unless intentionally public; no `console.log`; no secrets.
   - **spark-web** (`references/spark-web-checks.md`): new endpoints are
     **registered in the `QueryKey`/`Endpoint` maps and consumed through them**
     (no hardcoded paths/key strings); **mutations invalidate the right
     `QueryKey`(s)** on success; new mutations use **`handleMutationError`**;
     queries are **gated** (`enabled: !!…`); **Mantine v7** patterns and colors
     pulled from **`theme.ts`** (no Tailwind/shadcn/ad-hoc hex); no secrets.

5. **Hand off contract checks — do not re-implement them.** When the diff
   touches a request/response shape, a route, a DTO/serialized entity, or an
   `src/api/*` module, the authoritative check is the **`api-contract-check`**
   skill. Recommend running it; surface the touched endpoint(s) so it has a
   scope. Do **not** re-diff FE↔BE types here. Note that `api-contract-check`
   needs **both** sibling repos, while self-review runs in **one** — so when the
   sibling checkout is absent, it inherits that skill's single-repo degrade
   (self-consistency only: DTO↔zod, Endpoint-map↔module coverage). Flag the
   contract risk regardless; never claim "aligned" from one side.

6. **Classify and verdict.** Assign each finding a severity and emit the report
   per `references/report-template.md`: a findings table (`file:line | severity |
   what | fix-direction`) and an explicit **merge / do-not-merge / incomplete**
   verdict. Any blocker or unresolved high ⇒ do-not-merge. An unknown base or
   materially incomplete context ⇒ incomplete/human-review. Only a complete
   review with zero blockers/highs may clear the pre-PR gate.

## Guardrails (the Supaclass-specific judgment)

- **Review, don't rewrite.** Report findings with a fix *direction*, not a
  patch. The author fixes and re-runs. Rewriting the diff is out of scope.
- **Trust runtime validators and the entity over TS.** spark-api runs with
  strictness off (`strictNullChecks: false`); declared/inferred types can lie.
  The class-validator DTO is the request contract; the serialized entity is the
  response contract. (spark-web is strict-on — different footguns.)
- **`synchronize: true` = the entity is the live schema.** No migrations. Treat
  every entity/column edit as a schema mutation on next deploy and weigh
  data-loss before anything else.
- **Flag any added secret; credit a removed one.** A new private key, server
  token, credential, or service-account JSON is a **blocker**; never print its
  value. `spark-web` deliberately tracks only values intended to be public in
  its browser bundle, so review an added environment value for intended public
  exposure rather than flagging the filename alone. The obsolete API service
  account key is gone from the current tree but remains in history; never
  restore it. A cleanup diff should merge, with rotation/history work recorded
  separately where still applicable.
- **Never hardcode model IDs or context windows** in findings or examples — no
  `claude-*`/`gpt-*` literals, no "N-token window" assumptions. See
  `meta/model-currency.md`.
- **Read the source that changed**, not the PR description or a ticket. Derive
  every finding from a diff hunk with a file:line.
- **Scope to the diff.** Pre-existing debt outside the changed lines is not this
  review's job; note it once as a follow-up at most, don't expand the gate.

## References

- `references/spark-api-checks.md` — the backend checklist, each rule with what
  to grep for, why it bites, and the severity it maps to.
- `references/spark-web-checks.md` — the frontend checklist, same shape.
- `references/report-template.md` — the findings-table + merge/do-not-merge
  output format, and the severity rubric (blocker / high / medium / low).
