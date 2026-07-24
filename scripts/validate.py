#!/usr/bin/env python3
"""Validate the skills registry: structure, frontmatter, line budget,
symlink integrity, and a warn-only model-currency lint.

Stdlib only (no PyYAML): the frontmatter extractor reads just `name` and
`description`, handling folded/quoted scalars and ignoring nested maps like
`metadata:`. Run: `python3 scripts/validate.py` (or `just validate`).
Exits non-zero on any hard failure; warnings never fail the build.
"""

import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AGENTS_SKILLS = os.path.join(ROOT, ".agents", "skills")
CLAUDE_SKILLS = os.path.join(ROOT, ".claude", "skills")

NAME_RE = re.compile(r"^[a-z0-9-]+$")
LINE_WARN = 400
LINE_FAIL = 500

# Warn-only model-currency lint.
STALE_ID_RE = re.compile(
    r"\b(claude-2|claude-3|claude-instant|gpt-3|gpt-4-|text-davinci|text-curie)\b"
)
# Context-window literal only when token/context-adjacent, to avoid prose noise.
CONTEXT_WINDOW_RE = re.compile(r"\b\d+k\b(?=[^\n]{0,20}(token|context))", re.IGNORECASE)

errors = []
warnings = []


def fail(msg):
    errors.append(msg)


def warn(msg):
    warnings.append(msg)


def extract_frontmatter(text, path):
    """Return {'name':..., 'description':...} from top-level frontmatter keys.
    Handles same-line scalars, quotes, and folded/literal block scalars
    (>-, >, |, |-). Nested (indented) keys are ignored, so `metadata:` maps
    don't interfere."""
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        fail(f"{path}: missing opening '---' frontmatter fence")
        return {}
    end = None
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            end = i
            break
    if end is None:
        fail(f"{path}: unterminated frontmatter (no closing '---')")
        return {}

    block = lines[1:end]
    out = {}
    i = 0
    while i < len(block):
        line = block[i]
        # Only consider top-level keys (no leading whitespace).
        m = re.match(r"^([A-Za-z0-9_-]+):(.*)$", line)
        if not m or line[0].isspace():
            i += 1
            continue
        key, rest = m.group(1), m.group(2).strip()
        if rest in (">-", ">", "|", "|-", "|+", ">+"):
            # Block scalar: gather more-indented following lines.
            collected = []
            j = i + 1
            while j < len(block) and (block[j].strip() == "" or block[j][:1].isspace()):
                collected.append(block[j].strip())
                j += 1
            out[key] = " ".join(x for x in collected if x).strip()
            i = j
        else:
            out[key] = rest.strip().strip("'\"")
            i += 1
    return out


def check_skill(name):
    skill_dir = os.path.join(AGENTS_SKILLS, name)
    skill_md = os.path.join(skill_dir, "SKILL.md")
    rel = os.path.relpath(skill_md, ROOT)

    if not os.path.isfile(skill_md):
        fail(f"{name}: missing SKILL.md")
        return

    with open(skill_md, encoding="utf-8") as f:
        text = f.read()

    fm = extract_frontmatter(text, rel)

    fm_name = fm.get("name")
    if not fm_name:
        fail(f"{rel}: frontmatter missing 'name'")
    else:
        if len(fm_name) > 64:
            fail(f"{rel}: name >64 chars ({len(fm_name)})")
        if not NAME_RE.match(fm_name):
            fail(f"{rel}: name '{fm_name}' must match ^[a-z0-9-]+$")
        if fm_name != name:
            fail(f"{rel}: name '{fm_name}' != directory name '{name}'")

    desc = fm.get("description")
    if not desc:
        fail(f"{rel}: frontmatter missing 'description'")
    elif len(desc) > 1024:
        fail(f"{rel}: description >1024 chars ({len(desc)})")

    n_lines = len(text.splitlines())
    if n_lines >= LINE_FAIL:
        fail(f"{rel}: body {n_lines} lines (>= {LINE_FAIL} hard limit)")
    elif n_lines >= LINE_WARN:
        warn(f"{rel}: body {n_lines} lines (>= {LINE_WARN}; push detail to references/)")

    # Model-currency lint over SKILL.md + all references.
    for root_dir, _, files in os.walk(skill_dir):
        for fn in files:
            if not fn.endswith(".md"):
                continue
            fp = os.path.join(root_dir, fn)
            frel = os.path.relpath(fp, ROOT)
            with open(fp, encoding="utf-8") as fh:
                for lineno, line in enumerate(fh, 1):
                    for m in STALE_ID_RE.finditer(line):
                        warn(f"{frel}:{lineno}: stale model id '{m.group(0)}' — see meta/model-currency.md")
                    for m in CONTEXT_WINDOW_RE.finditer(line):
                        warn(f"{frel}:{lineno}: hardcoded context window '{m.group(0)}' — avoid baking in model assumptions")

    # Symlink integrity: .claude/skills/<name> -> .agents/skills/<name>
    link = os.path.join(CLAUDE_SKILLS, name)
    if not os.path.lexists(link):
        fail(f".claude/skills/{name}: missing symlink (run scripts/sync-skills.py)")
    elif not os.path.islink(link):
        fail(f".claude/skills/{name}: exists but is not a symlink")
    elif os.path.realpath(link) != os.path.realpath(skill_dir):
        fail(f".claude/skills/{name}: symlink resolves to {os.path.realpath(link)}, expected {os.path.realpath(skill_dir)}")


def main():
    if not os.path.isdir(AGENTS_SKILLS):
        print(f"FAIL: {os.path.relpath(AGENTS_SKILLS, ROOT)} does not exist")
        return 1

    skills = sorted(
        d for d in os.listdir(AGENTS_SKILLS)
        if os.path.isdir(os.path.join(AGENTS_SKILLS, d)) and not d.startswith(".")
    )
    if not skills:
        warn("no skills found under .agents/skills/")

    for name in skills:
        check_skill(name)

    for w in warnings:
        print(f"WARN  {w}")
    for e in errors:
        print(f"FAIL  {e}")

    print(f"\nChecked {len(skills)} skill(s): {len(errors)} error(s), {len(warnings)} warning(s).")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
