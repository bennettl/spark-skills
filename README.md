# supaclass-skills-registry

A cross-tool registry of reusable, purposeful AI dev skills for **Supaclass** — an
AI-assisted grading/LMS platform. One set of skills, authored once in the shared
[**Agent Skills**](https://agentskills.io) `SKILL.md` format, that works in **both
Claude Code and OpenAI Codex**.

It serves two application repos (siblings of this one):

- [`spark-api`](https://github.com/bennettl/spark-api) — NestJS 10 · TypeORM · Postgres · pnpm
- [`spark-web`](https://github.com/bennettl/spark-web) — React 18 · Vite · Mantine v7 · React Query v5 · Zustand · axios · zod

## Why this exists

Both application repos have build CI but no git hooks, and the API has no
migrations (`synchronize: true`). The frontend's API types are **hand-written to
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
  windows; a warn-only lint plus the [`skills-audit`](.agents/skills/skills-audit/SKILL.md)
  skill (which checks against a *live* model source, never a baked-in roster) keep
  the registry from rotting. See [`meta/model-currency.md`](meta/model-currency.md).

## Layout

```
.agents/skills/<name>/          # CANONICAL skill — Codex reads this directly
  SKILL.md                      # required: the source of truth
  references/                   # optional: loaded on demand
  scripts/  assets/             # optional: helpers / templates
.claude/skills/<name>           # symlink -> ../../.agents/skills/<name>  (Claude follows it)
meta/                           # conventions, distribution, model-currency, audit allowlist
scripts/                        # validate.py, audit.py, sync-skills.py, install.py  (Python 3, stdlib only)
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
| [`self-review`](.agents/skills/self-review/SKILL.md) | ✅ built | The pre-PR review gate. Reviews the actual-base branch diff against the repo's `AGENTS.md` rules plus the stack's traps; hands contract questions to `api-contract-check`. Emits file:line findings and a merge, do-not-merge, or incomplete/human-review verdict. Reviews; does not rewrite. |
| [`skills-audit`](.agents/skills/skills-audit/SKILL.md) | ✅ built | The registry's own gate. `validate.py` asks "well-formed?"; this asks **"still true?"** — dead app-repo paths, expiring hardcoded counts (`~55 of ~62 controllers`), reference and cross-skill integrity, and one stack fact authored in N skills with no declared owner. `scripts/audit.py` (`just audit`) is the mechanical half; the skill adds what a script can't — **live** model currency per [`meta/model-currency.md`](meta/model-currency.md) (never a baked-in roster), delegation-contract compatibility, and trigger overlap. |
| [`dual-repo-review`](.agents/skills/dual-repo-review/SKILL.md) | ✅ built | Reviews a paired spark-api + spark-web change as **one unit**. Delegates per-repo review to `self-review` and the REST seam to `api-contract-check`, then owns what neither can see from one side: pair integrity / orphan detection, the **hand-mirrored `EventType` + `CourseEvent` contract** (duplicated in both repos, covered by no other skill), enum parity, and merge/deploy ordering under `synchronize: true` — including whether the backend stays compatible with the *old* frontend during the deploy window. One aggregate verdict + a sequenced merge plan. |
| [`diagnose`](.agents/skills/diagnose/SKILL.md) | ✅ built | Root-causes a bug from a symptom — screenshot, error, failing request, or prose report. Classifies it against the stack's silent-failure modes (envelope depth, drift with no runtime validation, opt-in `ResponseInterceptor`, per-route guards, `synchronize: true`, `numeric`/`timestamptz` serialization), localizes the code, then **confirms or refutes each hypothesis by reading it**. Emits a root cause with file:line evidence, an explicit confidence label, and a ranked fix plan. Diagnoses and plans; does not patch. |

### Roadmap

Foundation, built next (one PR each): `domain-audit` (detect a business rule
re-derived across N surfaces), `git-commit`, and `nestjs-module` + `api-hook`
scaffolding. Also named as future work elsewhere in the registry: `authz-audit`
(app-repo authorization/security review — scope not yet defined).

The application repos now have initial build CI and Codex GitHub review enabled.
The reviewer remains advisory while it is evaluated under
[`meta/reviewer-pilot.md`](meta/reviewer-pilot.md). Custom orchestration,
auto-approval/merge, docs-RAG, and Slack digests remain deferred until measured
need and safety evidence justify them.

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
4. Audit: `python3 scripts/audit.py` (`just audit`) — checks whether the content is
   still *true*: app-repo paths that no longer exist, hardcoded counts that have
   since rotted, references and cross-skill links that don't resolve, and stack
   facts authored in several skills with no declared owner. `just check` runs both.
   Warnings are a worklist, not a verdict — an expiring count means *re-verify*,
   and most still hold. Paths cited on purpose while absent go in
   [`meta/audit-allow.txt`](meta/audit-allow.txt) with a reason.
5. Open a **pull request**. The `Registry` CI check runs the validator; Codex and
   human review cover judgment that deterministic validation cannot. Never
   commit finished work directly to `main`.

## Requirements

- **Python 3** (stdlib only) for the scripts — present by default on macOS/Linux.
- `just` is optional; every recipe is a plain `python3 scripts/*.py` invocation.
- Symlinks are committed to git. Fine on macOS/Linux; on a Windows checkout with
  `core.symlinks=false`, re-run `sync-skills.py` to materialize them.
