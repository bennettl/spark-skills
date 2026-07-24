#!/usr/bin/env python3
"""Regenerate .claude/skills/<name> symlinks from .agents/skills/<name>.

Each Claude entry is a relative symlink (../../.agents/skills/<name>) that Claude
Code follows. Codex reads .agents/skills directly and needs no symlink.
Run after adding or renaming a skill: `python3 scripts/sync-skills.py`
(or `just sync`). Stdlib only.
"""

import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AGENTS_SKILLS = os.path.join(ROOT, ".agents", "skills")
CLAUDE_SKILLS = os.path.join(ROOT, ".claude", "skills")


def main():
    if not os.path.isdir(AGENTS_SKILLS):
        print(f"error: {AGENTS_SKILLS} does not exist")
        return 1
    os.makedirs(CLAUDE_SKILLS, exist_ok=True)

    skills = sorted(
        d for d in os.listdir(AGENTS_SKILLS)
        if os.path.isdir(os.path.join(AGENTS_SKILLS, d)) and not d.startswith(".")
    )

    # Relative target from .claude/skills/<name> up to repo root, then down.
    for name in skills:
        link = os.path.join(CLAUDE_SKILLS, name)
        target = os.path.join("..", "..", ".agents", "skills", name)
        if os.path.islink(link) or os.path.lexists(link):
            os.remove(link)
        os.symlink(target, link)
        print(f"linked .claude/skills/{name} -> {target}")

    # Prune stale Claude entries whose source skill was removed.
    if os.path.isdir(CLAUDE_SKILLS):
        for entry in sorted(os.listdir(CLAUDE_SKILLS)):
            if entry not in skills:
                p = os.path.join(CLAUDE_SKILLS, entry)
                if os.path.islink(p):
                    os.remove(p)
                    print(f"pruned stale .claude/skills/{entry}")

    print(f"synced {len(skills)} skill(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
