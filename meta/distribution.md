# Distribution — how skills load in both tools

## Confirmed facts (official docs, July 2026)

- **Codex CLI** reads repository skills from `.agents/skills/` — scanned from the
  current working directory up through parents to the repo root — plus
  `$HOME/.agents/skills/`, `/etc/codex/skills/`, and built-ins. `.agents/` is the
  Agent Skills open-standard namespace.
- **Claude Code** reads `.claude/skills/` (project) and `~/.claude/skills/`
  (personal). It does **not** read `.agents/skills/`. But a `<skill-name>` entry
  under a skills dir **may be a symlink** to a target elsewhere on disk; Claude
  follows it, reads `SKILL.md` from the target, and de-dups if the same target is
  reachable more than once. Codex's symlink-following is **not** documented.

## Decision: Option B — canonical in `.agents/skills`, Claude via symlinks

- **Canonical files live in `.agents/skills/<name>/`.** Codex reads them directly
  — no reliance on undocumented symlink-following on the tool where it's unproven.
- **`.claude/skills/<name>` is a per-skill symlink** → `../../.agents/skills/<name>`.
  Claude follows it (officially supported). One symlink hop, only on the tool that
  documents it.
- `.agents/skills` is the neutral open-standard location, so "canonical =
  `.agents/skills`" does not privilege one tool.

`scripts/sync-skills.py` regenerates the `.claude/skills` symlinks from whatever
lives in `.agents/skills`. Run it after adding a skill.

## In-repo discovery (working inside spark-api / spark-web)

This registry is a **sibling** of the target repos, so its `.agents/skills` /
`.claude/skills` are **not** on the discovery path when the CWD is inside a target
repo. Two cases:

- **Cross-repo skills** (`api-contract-check`) run *from the registry root* with
  `../spark-api` / `../spark-web` as inputs — Option B loads them fine, no install.
- **In-repo skills** (deferred: `nestjs-module`, `api-hook`) are used *while
  working inside* a target repo, where the in-registry symlinks are invisible.

`scripts/install.py` (`just install`) symlinks each skill into the **global** dirs
`~/.agents/skills/<name>` (Codex) and `~/.claude/skills/<name>` (Claude), making
every registry skill discoverable from any CWD — without committing anything into
the target repos.

## Symlink caveats

- Symlinks are committed to git; fine on macOS/Linux. On a Windows checkout with
  `core.symlinks=false` the link materializes as a text file — run
  `sync-skills.py` (or use Codex-only, ignoring `.claude`) to recover.
- Fallback if a future tool version breaks symlink-following: `sync-skills.py`
  can copy instead of link, and the validator flags stale copies. Not needed now.
