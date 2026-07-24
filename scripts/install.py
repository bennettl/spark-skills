#!/usr/bin/env python3
"""Symlink each registry skill into the global tool dirs so the skills are
discoverable from any working directory — including inside spark-api / spark-web,
which are siblings of this registry and therefore off its local discovery path.

Targets:
  ~/.agents/skills/<name>  -> <repo>/.agents/skills/<name>   (Codex)
  ~/.claude/skills/<name>  -> <repo>/.agents/skills/<name>   (Claude Code)

Nothing is copied into the target repos. Re-run after adding a skill.
`python3 scripts/install.py` (or `just install`). Pass --dry-run to preview.
Stdlib only.
"""

import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AGENTS_SKILLS = os.path.join(ROOT, ".agents", "skills")
HOME = os.path.expanduser("~")
GLOBAL_DIRS = [
    os.path.join(HOME, ".agents", "skills"),
    os.path.join(HOME, ".claude", "skills"),
]


def main(argv):
    dry = "--dry-run" in argv
    if not os.path.isdir(AGENTS_SKILLS):
        print(f"error: {AGENTS_SKILLS} does not exist")
        return 1

    skills = sorted(
        d for d in os.listdir(AGENTS_SKILLS)
        if os.path.isdir(os.path.join(AGENTS_SKILLS, d)) and not d.startswith(".")
    )

    for gdir in GLOBAL_DIRS:
        if not dry:
            os.makedirs(gdir, exist_ok=True)
        for name in skills:
            link = os.path.join(gdir, name)
            target = os.path.join(AGENTS_SKILLS, name)  # absolute; global links live outside the repo
            action = "would link" if dry else "linked"
            if os.path.islink(link) and os.path.realpath(link) == os.path.realpath(target):
                print(f"ok   {link} (already linked)")
                continue
            if os.path.lexists(link) and not os.path.islink(link):
                print(f"skip {link}: exists and is not a symlink — leaving it alone")
                continue
            if not dry:
                if os.path.islink(link):
                    os.remove(link)
                os.symlink(target, link)
            print(f"{action} {link} -> {target}")

    print(f"\n{'(dry run) ' if dry else ''}installed {len(skills)} skill(s) into "
          f"{len(GLOBAL_DIRS)} global dir(s).")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
