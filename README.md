# supaclass-skills-registry

Cross-tool (Claude Code + OpenAI Codex) registry of reusable AI dev skills for
**Supaclass**, an AI-assisted grading/LMS platform. Serves two repos:

- [`spark-api`](https://github.com/bennettl/spark-api) — NestJS 10 + TypeORM + Postgres backend
- [`spark-web`](https://github.com/bennettl/spark-web) — React 18 + Vite + Mantine v7 frontend

Skills use the shared **Agent Skills** `SKILL.md` format, so one skill directory
works in both Claude Code and Codex.

## Layout

```
.agents/skills/<name>/SKILL.md   # canonical skill (Codex reads this directly)
.claude/skills/<name>            # symlink -> ../../.agents/skills/<name>  (Claude follows it)
meta/                            # conventions, model-currency policy, distribution decision
scripts/                         # validate.py, sync-skills.py, install.py (stdlib Python 3)
Justfile                         # optional convenience wrapper over scripts/
```

Why this shape: Codex reads `.agents/skills` directly (no reliance on symlink
following, which its docs don't promise); Claude Code reads `.claude/skills` and
officially follows per-skill symlinks. Canonical files live where the
unproven-symlink tool reads directly. Full reasoning: [`meta/distribution.md`](meta/distribution.md).

## Skills

| Skill | What it does |
|-------|--------------|
| [`api-contract-check`](.agents/skills/api-contract-check/SKILL.md) | Catch FE↔BE type drift between spark-api DTOs/entities and spark-web's hand-written API types + zod (no shared types, no codegen). |

More to come (self-review, domain-audit, nestjs-module, api-hook, meta audit).

## Add / validate a skill

```bash
python3 scripts/validate.py       # or: just validate
python3 scripts/sync-skills.py    # regenerate .claude/skills symlinks after adding a skill
```

The validator checks structure, frontmatter (`name`, `description`), a ~500-line
body budget, symlink integrity, and runs a warn-only model-currency lint.

## Use the skills

- **From this repo:** both tools auto-discover project skills when your working
  directory is the registry — Codex from `.agents/skills`, Claude from
  `.claude/skills`. No install step.
- **From inside spark-api / spark-web** (siblings of this repo, off its discovery
  path): run `python3 scripts/install.py` (`just install`) once to symlink the
  skills into `~/.agents/skills` and `~/.claude/skills`, making them discoverable
  from any directory. Nothing is written into the target repos.

Invoke explicitly with `/api-contract-check` (Claude Code) or `$api-contract-check`
(Codex), or let either tool trigger a skill implicitly by matching its
`description`.

> Creating a brand-new top-level skills directory mid-session requires restarting
> Claude Code so it can watch the directory; edits to existing skills are picked
> up live.

## Requirements

- **Python 3** (stdlib only) for the scripts — present by default on macOS/Linux.
- `just` is optional; every recipe is a plain `python3 scripts/*.py` invocation.
