---
name: self-review
description: >-
  Pre-PR self-review gate for the Supaclass app repos (spark-api, spark-web).
  Run it before opening a pull request — it is the ONLY automated
  gate, since neither repo has CI or git hooks. It reviews the working diff
  against main in whichever repo it runs in (or a repo root the caller
  names), auto-detects the repo, and loads
  that repo's AGENTS.md "Code Review Rules" plus the stack's non-obvious traps.
  spark-api: class-validator DTO classes, synchronize:true schema-change risk,
  ResponseInterceptor on new controllers, leaked entity fields / secrets /
  console.log, guarded routes. spark-web: QueryKey/Endpoint maps consumed (no
  hardcoded paths), mutation cache invalidation, handleMutationError, Mantine v7
  + theme.ts colors, gated queries. When the diff touches a request/response
  shape, a route, or an api module it hands off to the api-contract-check skill
  rather than re-diff contracts. Emits findings with file:line + severity and an
  explicit merge / do-not-merge verdict. It reviews; it does not rewrite.
metadata:
  supaclass-repos: [spark-api, spark-web]
  maturity: vertical-slice
---

# self-review

Neither spark-api nor spark-web has CI or git hooks — **review is the only gate**
before a PR merges. This skill is that gate, run by the author on their own
branch before opening the PR. It scopes to what actually changed, applies the
checks the repo's `AGENTS.md` calls highest-value, and returns a blunt
**merge / do-not-merge** verdict with file:line findings. It is a review, not a
rewrite: it tells you what to fix, it does not fix it.

## When this fires

Run it on a feature branch **before opening a PR**, and again after addressing
findings. Skip it for a no-op branch (docs-only, a `.md` tweak) — say so and
stop. If unsure, run it: a clean pass costs a minute, a missed blocker ships a
bug into a repo with no other safety net.

## Inputs

- **The branch diff.** Review only the changed files, not the whole repo.
  Compute the base with `git merge-base main HEAD`, then
  `git diff <base>...HEAD` for committed changes **plus** `git diff <base>` (or
  `git status`) so uncommitted working-tree edits are included — you are gating
  what will land, not just what's committed. If the branch isn't off `main`,
  say which base you used.
- **The repo.** Default to auto-detecting which repo you're in (see Method 2) and
  load its rule set. **Accept an explicit repo root if the caller names one** —
  e.g. `../spark-api` — and detect against *that* root rather than the working
  directory, matching `api-contract-check`'s input contract. This is what lets an
  orchestrator (`dual-repo-review`) invoke this skill per repo without changing
  the session's working directory; without it, a call from a third directory
  detects "neither" and degrades to stack-neutral checks only. The `references/*-checks.md` files in this skill are the **source of
  truth** for the checklists; the repo's `AGENTS.md` "Code Review Rules" +
  "Non-obvious rules" are the confirmatory, possibly-newer overlay. Read
  `AGENTS.md` when present and let it override; **degrade gracefully** when it's
  absent by falling back to the reference checklist — never to "no checks."
- **Nothing else.** No ticket, no PR description. Review the source that
  changed.

## Method

1. **Get the diff.** Resolve the base (`git merge-base main HEAD`) and collect
   the changed file list + hunks (committed and uncommitted). Group by area
   (controller, entity, dto, api module, component, …) so checks map cleanly.

2. **Detect the repo** from files at the root of the target — the explicit repo
   root if the caller named one, otherwise the working directory — not from the
   directory name:
   - **spark-api** — `nest-cli.json`, `@nestjs/core` in `package.json`, and the
     `src/<feature>/{controller,service,entity,dto}` module layout.
   - **spark-web** — `vite.config.ts` + `src/api/const.ts`, `react` + `@mantine/*`
     in `package.json`.
   - **neither** — no match. Run only the stack-neutral checks (added secrets,
     leftover `console.log`/debug, obvious footguns), state that repo-specific
     rules were unavailable, and keep the verdict scoped to what you could check.

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
   what | fix-direction`) and an explicit **merge / do-not-merge**. Any blocker
   or unresolved high ⇒ do-not-merge. Zero findings ⇒ say so plainly and clear
   the merge.

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
- **Flag any added secret; credit a removed one.** A new key, token, `.env`
  value, or service-account JSON in the diff is a **blocker** — both repos
  already carry a committed-secret problem; do not add a third. Never print the
  secret's value. Conversely, a diff that *untracks or deletes* a committed
  secret is the prescribed remediation, **not** a finding — but it's rarely
  complete: the value stays in git history and stays live until rotated. Clear
  the merge and record a **low follow-up** (rotate the credential + purge
  history); do not block the cleanup PR, and do not mistake removal for a
  finished fix.
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
