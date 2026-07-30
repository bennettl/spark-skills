# supaclass-skills-registry

A cross-tool registry of reusable, purposeful AI dev skills for **Supaclass** — an
AI-assisted grading/LMS platform. One set of skills, authored once in the shared
[**Agent Skills**](https://agentskills.io) `SKILL.md` format, that works in **both
Claude Code and OpenAI Codex**.

It serves two application repos (siblings of this one):

- [`spark-api`](https://github.com/bennettl/spark-api) — NestJS 10 · TypeORM · Postgres · pnpm
- [`spark-web`](https://github.com/bennettl/spark-web) — React 18 · Vite · Mantine v7 · React Query v5 · Zustand · axios · zod

## Why this exists

Both repos are effectively solo, low-velocity, and have **no CI, no hooks, and no
migrations** (`synchronize: true`). The frontend's API types are **hand-written to
mirror the backend — no shared types, no codegen** — so the two drift silently.
This registry packages the recurring review-and-scaffold work into skills that
either tool can invoke, so the checks that would otherwise live in someone's head
(or a stale doc) run on demand and stay consistent across both AI assistants.

Design principles:

- **Tool-neutral core, thin adapters.** One `SKILL.md` per skill is the source of
  truth. Tool-specific extensions (Codex `agents/openai.yaml`, Claude
  `context: fork`, plugin manifests) are optional and non-breaking — each tool
  ignores the other's.
- **Intent over rigid scripts.** Skills state *what* to do and the judgment calls,
  not a click-by-click procedure; current models need the guardrails, not the
  hand-holding.
- **Model-currency is first-class.** Skills never hardcode model IDs or context
  windows; a warn-only lint and a planned `audit` skill (which checks against a
  *live* model source) keep the registry from rotting. See
  [`meta/model-currency.md`](meta/model-currency.md).

## Layout

```
.agents/skills/<name>/          # CANONICAL skill — Codex reads this directly
  SKILL.md                      # required: the source of truth
  references/                   # optional: loaded on demand
  scripts/  assets/             # optional: helpers / templates
.claude/skills/<name>           # symlink -> ../../.agents/skills/<name>  (Claude follows it)
meta/                           # conventions, distribution decision, model-currency policy
scripts/                        # validate.py, sync-skills.py, install.py  (Python 3, stdlib only)
Justfile                        # optional convenience wrapper over scripts/
```

### How the two tools load a skill

| Tool | Reads from | Mechanism |
|------|-----------|-----------|
| **Codex CLI** | `.agents/skills/` (CWD → parents → repo root; also `~/.agents/skills`) | Reads the canonical files directly. |
| **Claude Code** | `.claude/skills/` (project) + `~/.claude/skills/` (personal) | Follows the per-skill **symlink** to the canonical `.agents/skills` dir. |

Canonical files live in `.agents/skills` (the neutral open-standard location, which
Codex reads with no indirection); `.claude/skills/<name>` is a per-skill symlink
that Claude Code officially follows. This puts the real files where the tool with
*undocumented* symlink support (Codex) reads directly, and uses symlinks only where
following is *documented* (Claude). Full reasoning:
[`meta/distribution.md`](meta/distribution.md).

## Skills

| Skill | Status | What it does |
|-------|--------|--------------|
| [`api-contract-check`](.agents/skills/api-contract-check/SKILL.md) | ✅ built | Catches FE↔BE type drift between spark-api DTOs/entities and spark-web's hand-written API types. Encodes the stack's traps: trust class-validator DTOs / serialized entities over TS-inferred types (`strictNullChecks: false`), `synchronize: true` ⇒ entity = live schema, response-envelope & pagination detection, request-side query/param string-coercion. |
| [`self-review`](.agents/skills/self-review/SKILL.md) | ✅ built | The pre-PR gate — the only one, since neither repo has CI or hooks. Reviews the branch diff in whichever repo it runs in against that repo's `AGENTS.md` "Code Review Rules" plus the stack's traps; hands contract questions to `api-contract-check`. Emits file:line findings with severity and a merge / do-not-merge verdict. Reviews; does not rewrite. |
| [`diagnose`](.agents/skills/diagnose/SKILL.md) | ✅ built | Root-causes a bug from a symptom — screenshot, error, failing request, or prose report. Classifies it against the stack's silent-failure modes (envelope depth, drift with no runtime validation, opt-in `ResponseInterceptor`, per-route guards, `synchronize: true`, `numeric`/`timestamptz` serialization), localizes the code, then **confirms or refutes each hypothesis by reading it**. Emits a root cause with file:line evidence, an explicit confidence label, and a ranked fix plan. Diagnoses and plans; does not patch. |

### Roadmap

Foundation, built next (one PR each): `domain-audit` (detect a business rule
re-derived across N surfaces), `git-commit`, `nestjs-module` + `api-hook`
scaffolding, and a meta `audit` (with the model-currency check). Also planned:
per-repo `CLAUDE.md` / `AGENTS.md` authored *into* spark-api and spark-web — the
standards the review skills check against.

Deferred until the substrate exists (CI, a ticket system, notifications): the whole
autonomous pipeline (worktree sessions, auto-reviewer, respond-to-review,
ticket-ingester, overnight-runner), docs-RAG, and Slack digests.

## Using the skills

- **From this repo:** both tools auto-discover project skills when your working
  directory is the registry — Codex from `.agents/skills`, Claude from
  `.claude/skills`. No install step.
- **From inside spark-api / spark-web** (siblings of this repo, off its discovery
  path): run `python3 scripts/install.py` (`just install`) once. It symlinks the
  skills into `~/.agents/skills` and `~/.claude/skills` so they're discoverable from
  any directory, and prunes stale links from renamed/removed skills. Nothing is
  written into the target repos.

Invoke explicitly with `/api-contract-check` (Claude Code) or `$api-contract-check`
(Codex), or let either tool trigger a skill implicitly by matching its `description`.

> Creating a brand-new top-level skills directory mid-session requires restarting
> Claude Code so it can watch the directory; edits to existing skills are picked up
> live.

## Authoring a skill

1. Scaffold: `just new my-skill` (creates `.agents/skills/my-skill/` with a
   `SKILL.md` stub and refreshes the Claude symlink).
2. Write the `SKILL.md` body and push detail into `references/`. Follow
   [`meta/conventions.md`](meta/conventions.md): frontmatter needs a `name`
   (lowercase-hyphen, ≤64 chars, equal to the directory name) and a `description`
   (≤1024 chars — this is the trigger both tools match on); keep the body under
   ~500 lines.
3. Validate: `python3 scripts/validate.py` (`just validate`) — checks structure,
   frontmatter, the body line budget, symlink integrity, and a warn-only
   model-currency lint. Exits non-zero on hard failures only.
4. Open a **pull request** (this repo has no CI, so review is the gate — never
   commit finished work directly to `main`).

## Requirements

- **Python 3** (stdlib only) for the scripts — present by default on macOS/Linux.
- `just` is optional; every recipe is a plain `python3 scripts/*.py` invocation.
- Symlinks are committed to git. Fine on macOS/Linux; on a Windows checkout with
  `core.symlinks=false`, re-run `sync-skills.py` to materialize them.
