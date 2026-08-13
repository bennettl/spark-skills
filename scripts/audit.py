#!/usr/bin/env python3
"""Audit the skills registry for *truth* and *coherence*, not structure.

`validate.py` answers "is this a well-formed skill?" — frontmatter, name, line
budget, symlinks. This answers the questions that let a structurally-perfect
registry go quietly wrong:

  1. reference integrity  — do the files a SKILL.md cites exist, and is every
                            reference file actually cited?
  2. skill cross-refs     — does a skill delegate to a skill that exists?
  3. repo path truth      — do the app-repo paths skills name still exist?
  4. expiring facts       — hardcoded counts ("~55 of ~62 controllers") that are
                            correct today and wrong after the next merge.
  5. ownership overlap    — one stack fact independently authored in N skills,
                            which is how copies drift apart.

Every check here was motivated by a defect that actually shipped or nearly did.
Stdlib only. Run: `python3 scripts/audit.py` (or `just audit`).
Exits non-zero on hard failures only; warnings never fail the build.

The live model-currency check is deliberately NOT here — `meta/model-currency.md`
requires querying a live model source at run time, which is the `skills-audit`
skill's job, not a stdlib script's. This covers the static half.

KNOWN LIMITATIONS (false negatives — a clean run is not proof of correctness):

  * Only **backticked** tokens are inspected. A path or skill name written in
    plain prose is invisible to every check here.
  * Path checks only fire for tokens starting with PATH_ROOTS. A bare filename
    (`app.module.ts`, `theme.ts`, `const.ts`) is NOT verified, and skills use
    those often.
  * A path is "found" if it exists in *either* app repo — a spark-web path that
    only exists in spark-api still passes.
  * Prose assertions about behavior ("the pipe has no transform", "no global
    APP_GUARD") cannot be checked mechanically. That's step 5 of the skill.
  * Ownership counts are **line hits**, not file counts, and the deferral test is
    a keyword window — it can be fooled either way.

These are the reason `skills-audit` has a judgment half. Treat this script as the
floor, not the ceiling.
"""

import difflib
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AGENTS_SKILLS = os.path.join(ROOT, ".agents", "skills")

# App repos are siblings of the registry. Absent is not an error — the path
# checks degrade to "skipped" rather than reporting every path as missing.
APP_REPOS = {
    "spark-api": os.path.abspath(os.path.join(ROOT, "..", "spark-api")),
    "spark-web": os.path.abspath(os.path.join(ROOT, "..", "spark-web")),
}

# Report templates are illustrative by nature — their paths and numbers are
# worked examples, not claims. Real claims belong in the body or references.
EXEMPT_BASENAMES = {"report-template.md"}

# Paths deliberately cited while absent (unmerged branches, worked examples).
ALLOW_FILE = os.path.join(ROOT, "meta", "audit-allow.txt")

# A backticked token is a candidate repo path if it has a separator and starts
# with a real top-level dir in either repo.
PATH_ROOTS = ("src/", "libs/", "scripts/", "docs/", "test/", "onetime/", "meta/")
# Roots that also exist in THIS repo — resolve locally before blaming an app repo.
REGISTRY_ROOTS = ("meta/", "scripts/")
PLACEHOLDER = re.compile(r"[<>*{}]|\.\.\.|…|\bN\b|:line")
BACKTICKED = re.compile(r"`([^`\n]+)`")
LINE_SUFFIX = re.compile(r":\d+(-\d+)?$")
# Shaped like a skill name: kebab-case, lowercase, no dots/slashes/spaces.
SKILL_SHAPE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)+$")

# Counts that are true on the day they're written and rot on the next merge.
EXPIRING = [
    (re.compile(r"~?\d+\s+of\s+~?\d+"), "count-of-total"),
    (re.compile(r"~\d+\s+(?:api\s+)?(?:modules|controllers|folders|files|entities|routes)"), "approx-count"),
    (re.compile(r"only\s+~?\d+\s+\S+\s+files?\s+exist"), "approx-count"),
]

# Core stack facts. If one is authored in more than OWNERSHIP_THRESHOLD skills
# with no declared owner, the copies will drift — that already happened once.
CORE_FACTS = [
    ("synchronize:true / live schema", re.compile(r"synchronize", re.I)),
    ("ResponseInterceptor / envelope", re.compile(r"ResponseInterceptor")),
    ("envelope unwrap depth", re.compile(r"res\.data\.data")),
    ("QueryKey / Endpoint maps", re.compile(r"QueryKey")),
    ("class-validator DTOs", re.compile(r"class-validator")),
    ("TS strictness off", re.compile(r"strictNullChecks")),
    ("handleMutationError", re.compile(r"handleMutationError")),
    ("zod does not validate", re.compile(r"zod", re.I)),
]
OWNERSHIP_THRESHOLD = 2
# A skill may declare it defers to another for a fact; that resolves the overlap.
# Deferral rarely sits on the same line as the fact — it's usually a sentence in
# the same paragraph — so match within a window of lines around each hit.
DEFERS = re.compile(r"\bowns?\b|\bdefer|\bdelegate|\bwins\b|\bauthoritative\b", re.I)
DEFER_WINDOW = 6

errors, warnings, notes = [], [], []


def fail(m):
    errors.append(m)


def warn(m):
    warnings.append(m)


def note(m):
    notes.append(m)


def md_files(skill_dir):
    for base, _, files in os.walk(skill_dir):
        for fn in sorted(files):
            if fn.endswith(".md"):
                yield os.path.join(base, fn)


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def rel(path):
    return os.path.relpath(path, ROOT)


def load_allowed_paths():
    """Claim-scoped absent paths. See meta/audit-allow.txt."""
    allowed = set()
    if not os.path.isfile(ALLOW_FILE):
        return allowed
    for line in read(ALLOW_FILE).splitlines():
        entry = line.split("#", 1)[0].strip()
        if entry:
            parts = tuple(part.strip() for part in entry.split("|", 1))
            if len(parts) != 2 or not all(parts):
                fail(f"{rel(ALLOW_FILE)}: malformed allow entry '{entry}'")
                continue
            allowed.add(parts)
    return allowed


def check_reference_integrity(name, skill_dir):
    """SKILL.md cites references/x.md that exists; every reference is cited."""
    skill_md = os.path.join(skill_dir, "SKILL.md")
    if not os.path.isfile(skill_md):
        return
    body = read(skill_md)
    cited = set(re.findall(r"references/([A-Za-z0-9._/-]+\.md)", body))

    ref_dir = os.path.join(skill_dir, "references")
    on_disk = set()
    if os.path.isdir(ref_dir):
        on_disk = {
            os.path.relpath(os.path.join(base, f), ref_dir).replace(os.sep, "/")
            for base, _, files in os.walk(ref_dir)
            for f in files
            if f.endswith(".md")
        }

    ref_root_real = os.path.realpath(ref_dir)
    for ref in sorted(cited):
        candidate = os.path.abspath(os.path.join(ref_dir, ref))
        candidate_real = os.path.realpath(candidate)
        if (
            os.path.commonpath((ref_dir, candidate)) != ref_dir
            or os.path.commonpath((ref_root_real, candidate_real)) != ref_root_real
        ):
            fail(f"{name}: unsafe reference path references/{ref}")
        elif not os.path.isfile(candidate):
            fail(f"{name}: SKILL.md cites unreadable references/{ref}")

    for missing in sorted(cited - on_disk):
        fail(f"{name}: SKILL.md cites references/{missing} which does not exist")
    for orphan in sorted(on_disk - cited):
        warn(f"{name}: references/{orphan} exists but SKILL.md never cites it")


def check_skill_crossrefs(name, skill_dir, all_skills):
    """A skill naming another skill must name one that exists — or one we know is
    planned. Referencing a roadmap skill in prose ("that's authz-audit's job") is
    legitimate forward reference, not a broken delegation. Only a name that is
    neither built nor planned is a real error: that's a typo or a stale rename."""
    for path in md_files(skill_dir):
        text = read(path)
        lines = text.splitlines()
        seen = set()
        for m in BACKTICKED.finditer(text):
            tok = m.group(1).strip()
            if tok == name or tok in all_skills:
                continue
            line = text[: m.start()].count("\n") + 1
            token_line = lines[line - 1]
            direct_callees = re.findall(
                r"(?:delegat(?:e|es|ed|ing|ion)|handoff|hand off)\s+"
                r"(?:directly\s+)?(?:to\s+)?`([^`]+)`",
                token_line,
                re.I,
            )
            direct_context = tok in {callee.strip() for callee in direct_callees}
            explicit_context = direct_context or bool(re.search(r"\bskill\b", token_line, re.I))
            if not direct_context and re.match(r"\s*[-*+]\s+", token_line):
                previous = line - 2
                if previous >= 0 and not lines[previous].strip():
                    previous -= 1
                if previous >= 0:
                    list_context = re.search(
                        r"(?:delegat(?:e|es|ed|ion)|handoff|hand off)[^`]*:\s*$",
                        lines[previous],
                        re.I,
                    )
                    bullet_callees = [value.strip() for value in BACKTICKED.findall(token_line)]
                    direct_context = bool(list_context and bullet_callees and bullet_callees[0] == tok)
                    explicit_context = explicit_context or direct_context
            if tok in PLANNED_SKILLS:
                if tok not in seen:
                    seen.add(tok)
                    if direct_context:
                        fail(
                            f"{rel(path)}:{line}: directly delegates to planned skill "
                            f"'{tok}', which is not built"
                        )
                    else:
                        note(f"{rel(path)}:{line}: references planned skill '{tok}' (not built yet)")
                continue
            # Unknown token. Only consider ones shaped like a skill name — the
            # registry is full of kebab-case tokens that are libraries, not skills.
            if not SKILL_SHAPE.match(tok) or tok in seen:
                continue
            if direct_context:
                seen.add(tok)
                fail(
                    f"{rel(path)}:{line}: directly delegates to missing skill '{tok}'"
                )
                continue
            if not explicit_context:
                continue
            close = difflib.get_close_matches(tok, sorted(KNOWN_SKILL_NAMES), n=1, cutoff=0.8)
            if close:
                seen.add(tok)
                fail(
                    f"{rel(path)}:{line}: references skill '{tok}' which does not exist "
                    f"— did you mean '{close[0]}'? (typo or stale rename)"
                )
            else:
                seen.add(tok)
                warn(
                    f"{rel(path)}:{line}: '{tok}' is described as a skill but is neither "
                    f"built nor in the planned set — stale reference, or add it to PLANNED_SKILLS"
                )


def candidate_paths(text):
    """Backticked tokens that look like claims about a real app-repo file."""
    for m in BACKTICKED.finditer(text):
        tok = m.group(1).strip().rstrip(".,;:)")
        if PLACEHOLDER.search(tok):
            continue
        tok = LINE_SUFFIX.sub("", tok)
        if not tok.startswith(PATH_ROOTS):
            continue
        if "/" not in tok:
            continue
        yield m, tok


def check_repo_paths(name, skill_dir, available):
    """Do the app-repo paths this skill names still exist?

    This is the check that has caught the most real defects: a dead
    docs/credit-reservation.md, a scripts/setup-queue.sh that lived only on an
    unmerged branch. A wrong path reads as verified, which is worse than silence.
    """
    for path in md_files(skill_dir):
        if os.path.basename(path) in EXEMPT_BASENAMES:
            continue
        text = read(path)
        for m, tok in candidate_paths(text):
            if tok.startswith(REGISTRY_ROOTS):
                # These roots exist in this repo too. Resolve locally; only fall
                # through to the app repos if it isn't a registry file.
                registry_candidate = os.path.abspath(os.path.join(ROOT, tok))
                if (
                    os.path.commonpath((ROOT, registry_candidate)) == ROOT
                    and os.path.exists(registry_candidate)
                ):
                    continue
                if tok.startswith("meta/"):
                    line = text[: m.start()].count("\n") + 1
                    fail(f"{rel(path)}:{line}: registry path '{tok}' does not exist")
                    continue
            if (rel(path), tok) in ALLOWED_PATHS:
                continue
            # A token may belong to the missing sibling. Until both app repos
            # are available, a negative conclusion is ambiguous; keep local
            # registry-path checks above, but skip app-path absence warnings.
            if set(available) != set(APP_REPOS):
                continue
            found = False
            for repo_root in available.values():
                candidate = os.path.abspath(os.path.join(repo_root, tok))
                if (
                    os.path.commonpath((repo_root, candidate)) == repo_root
                    and os.path.exists(candidate)
                ):
                    found = True
                    break
            if not found:
                line = text[: m.start()].count("\n") + 1
                where = " or ".join(sorted(available))
                warn(f"{rel(path)}:{line}: path '{tok}' not found in {where}")


def check_expiring_facts(name, skill_dir):
    """Hardcoded counts about the codebase rot on the next merge."""
    for path in md_files(skill_dir):
        if os.path.basename(path) in EXEMPT_BASENAMES:
            continue
        text = read(path)
        for lineno, line in enumerate(text.splitlines(), 1):
            for pat, kind in EXPIRING:
                m = pat.search(line)
                if m:
                    warn(
                        f"{rel(path)}:{lineno}: expiring {kind} '{m.group(0).strip()}' "
                        f"— true when written, stale after the next merge; re-verify"
                    )
                    break


def check_ownership(skills):
    """One fact authored in many skills is how copies drift apart."""
    for label, pat in CORE_FACTS:
        holders = {}
        for name, skill_dir in skills.items():
            hits = 0
            defers = False
            for path in md_files(skill_dir):
                lines = read(path).splitlines()
                for i, line in enumerate(lines):
                    if not pat.search(line):
                        continue
                    hits += 1
                    # Deferral is usually a nearby sentence, not the same line.
                    lo = max(0, i - DEFER_WINDOW)
                    hi = min(len(lines), i + DEFER_WINDOW + 1)
                    if DEFERS.search("\n".join(lines[lo:hi])):
                        defers = True
            if hits:
                holders[name] = (hits, defers)
        if len(holders) > OWNERSHIP_THRESHOLD:
            undeclared = [n for n, (_, d) in holders.items() if not d]
            # Counts are line hits, not files — label them so nobody reads them
            # as "N files" and draws the wrong conclusion about spread.
            detail = ", ".join(f"{n}({c} lines)" for n, (c, _) in sorted(holders.items()))
            if len(undeclared) > OWNERSHIP_THRESHOLD:
                warn(
                    f"ownership: '{label}' independently stated in {len(holders)} skills "
                    f"[{detail}] with no deferral in {len(undeclared)} of them — "
                    f"declare one owner or these will diverge"
                )
            else:
                note(f"ownership: '{label}' in {len(holders)} skills [{detail}] — deferrals present")


def main():
    if not os.path.isdir(AGENTS_SKILLS):
        print(f"FAIL: {os.path.relpath(AGENTS_SKILLS, ROOT)} does not exist")
        return 1

    skills = {
        d: os.path.join(AGENTS_SKILLS, d)
        for d in sorted(os.listdir(AGENTS_SKILLS))
        if os.path.isdir(os.path.join(AGENTS_SKILLS, d)) and not d.startswith(".")
    }

    global KNOWN_SKILL_NAMES, PLANNED_SKILLS
    # Roadmap skills. A prose reference to one is a forward reference, not a
    # broken link — keep this in sync as they get built or dropped.
    PLANNED_SKILLS = {
        "preflight", "open-pr", "authz-audit", "issue-refine", "smoke-test",
        "domain-audit", "nestjs-module", "api-hook", "git-commit",
    }
    KNOWN_SKILL_NAMES = set(skills) | PLANNED_SKILLS

    global ALLOWED_PATHS
    ALLOWED_PATHS = load_allowed_paths()
    if ALLOWED_PATHS:
        note(f"{len(ALLOWED_PATHS)} path claim(s) allowlisted via meta/audit-allow.txt")

    available = {n: p for n, p in APP_REPOS.items() if os.path.isdir(p)}
    missing_repos = sorted(set(APP_REPOS) - set(available))
    if missing_repos:
        note(
            "app-path absence verification fully deferred until both sibling "
            f"repos are checked out (missing: {', '.join(missing_repos)})"
        )

    for name, skill_dir in skills.items():
        check_reference_integrity(name, skill_dir)
        check_skill_crossrefs(name, skill_dir, skills)
        check_repo_paths(name, skill_dir, available)
        check_expiring_facts(name, skill_dir)
    check_ownership(skills)

    for n in notes:
        print(f"NOTE  {n}")
    for w in warnings:
        print(f"WARN  {w}")
    for e in errors:
        print(f"FAIL  {e}")

    print(
        f"\nAudited {len(skills)} skill(s) with {len(available)} app repo(s) available: "
        f"{len(errors)} error(s), {len(warnings)} warning(s)."
    )
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
