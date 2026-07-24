# Skill conventions

The rules `scripts/validate.py` enforces, and the reasoning behind them.

## Layout

```
.agents/skills/<skill-name>/      # canonical location — Codex reads this directly
  SKILL.md                        # required, the source of truth
  references/                     # optional, loaded on demand
  scripts/                        # optional, deterministic helpers
  assets/                         # optional, templates/icons
```

`.claude/skills/<skill-name>` is a **symlink** to the matching `.agents/skills`
directory (Claude Code follows it). See `distribution.md`.

## Frontmatter (SKILL.md)

Required:
- `name` — lowercase, hyphen-separated, `^[a-z0-9-]+$`, ≤ 64 chars, **equal to the
  skill's directory name**. This is the invocation command (`/name`, `$name`).
- `description` — ≤ 1024 chars. This is the trigger: both Claude Code and Codex
  decide whether to surface the skill by matching against it. State *when* to use
  the skill, not just what it does.

Optional (standard, portable): `license`, `compatibility`, `metadata`,
`allowed-tools`.

**Keep tool-specific keys out of the shared SKILL.md.** Codex extensions belong in
`agents/openai.yaml`; Claude extensions (`context: fork`, plugin manifests) belong
in their own files. Each tool ignores the other's; the SKILL.md stays neutral.

## Body

- Markdown, target **< 500 lines** (validator warns at 400, fails at 500).
- Push detail into `references/` — those load only when the skill is actually used.
- Prefer intent + guardrails over rigid step-by-step scripts. Current models need
  the *what* and the *judgment calls*, not a click-by-click procedure.

## Model currency

Skills must not hardcode model IDs or context-window assumptions. The validator
runs a warn-only model-currency lint (see `model-currency.md`). On a major model
release, run the `audit` meta-skill.
