# Optional convenience wrapper. `just` is not required — every recipe is a
# one-line `python3 scripts/*.py` you can run directly.
#   validate         → check structure, frontmatter, line budget, symlinks, model currency
#   validate-ledgers → check reviewer-pilot ledger structure, enums, and cross-references
#   sync             → regenerate .claude/skills symlinks from .agents/skills
#   install          → symlink skills into ~/.agents/skills and ~/.claude/skills (global)
#   new              → scaffold a new skill directory

validate:
    python3 scripts/validate.py

validate-ledgers:
    python3 scripts/validate_reviewer_ledgers.py

sync:
    python3 scripts/sync-skills.py

install:
    python3 scripts/install.py

install-dry:
    python3 scripts/install.py --dry-run

# Scaffold a new skill: `just new my-skill`
new name:
    mkdir -p .agents/skills/{{name}}/references
    printf '%s\n' '---' 'name: {{name}}' 'description: >-' '  TODO: one-paragraph trigger — say WHEN to use this skill.' '---' '' '# {{name}}' '' 'TODO: body.' > .agents/skills/{{name}}/SKILL.md
    python3 scripts/sync-skills.py
    @echo "created .agents/skills/{{name}} — edit SKILL.md, then run: just validate"
