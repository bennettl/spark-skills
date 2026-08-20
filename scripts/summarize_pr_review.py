#!/usr/bin/env python3
"""Collapse @codex/@claude inline review comments on one PR into a single,
reviewer-agnostic summary — the first real slice of the multi-reviewer
orchestration agent described in meta/multi-reviewer-matching.md.

Fetches live via `gh api` (stdlib + gh CLI only). Defaults to the most recent
commit any configured reviewer has commented against; pass a commit SHA to
pin an earlier boundary explicitly.

Two things this deliberately does NOT do, by design, not oversight:
- Cross-file or cross-boundary matching (e.g. "reviewer A flagged this on an
  earlier commit and it's unfixed"). That requires either the persisted
  ledger history or a semantic judgment call, not something a same-boundary
  parser can safely infer. Only same-file, same-boundary clustering is
  automatic here.
- Fine-grained severity below "major" (P0/P1, blocker-eligible) vs "minor"
  (P2/P3). Verified against reviewer-finding-ledger.csv's PR #94 ground truth
  that Claude's inline comments only ever carry two distinct severity emoji
  (🔴/🟡) even where the hand-curated ledger records some as P3 — the emoji
  does not reliably encode a P2-vs-P3 split, so this script doesn't claim one.
  major/minor is exactly the distinction the taxonomy's blocker/agent-clear
  gate actually needs (see reviewer-pilot.md), so nothing operationally
  load-bearing is lost.

Usage: summarize_pr_review.py <owner> <repo> <pr_number> [commit_sha]
"""
import json
import re
import subprocess
import sys
from collections import defaultdict

REVIEWER_LOGINS = {
    "chatgpt-codex-connector[bot]": "codex",
    "claude[bot]": "claude",
}

CODEX_RE = re.compile(
    r"!\[P(\d) Badge\]\([^)]+\)</sub></sub>\s+(.+?)\*\*\s*\n+(.*?)\n+Useful\? React",
    re.DOTALL,
)
CLAUDE_RE = re.compile(r"^(🔴|🟡|🟢)\s+(.*?)(?:\n+<details>|$)", re.DOTALL)

# major = blocker-eligible (P0/P1); minor = everything else. This is the only
# severity split the taxonomy's own gating logic depends on.
CODEX_TIER = {"0": "major", "1": "major", "2": "minor", "3": "minor", "4": "minor"}
CLAUDE_TIER = {"🔴": "major", "🟡": "minor", "🟢": "minor"}

SAME_FILE_LINE_WINDOW = 5


def gh_api(path):
    out = subprocess.run(["gh", "api", path], capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


def parse_codex(body):
    m = CODEX_RE.search(body)
    if not m:
        return None
    digit, title, summary = m.groups()
    return {"tier": CODEX_TIER.get(digit, "minor"), "raw_severity": f"P{digit}",
            "title": title.strip(), "summary": summary.strip()}


def parse_claude(body):
    m = CLAUDE_RE.match(body)
    if not m:
        return None
    marker, text = m.groups()
    return {"tier": CLAUDE_TIER[marker], "raw_severity": marker,
            "title": None, "summary": text.strip()}


PARSERS = {"codex": parse_codex, "claude": parse_claude}


def cluster_same_file(findings):
    """Greedy same-file, line-proximity clustering. Cross-file / cross-boundary
    matches are intentionally left unclustered — see module docstring."""
    by_path = defaultdict(list)
    for f in findings:
        by_path[f["path"]].append(f)

    clusters = []
    for path, items in by_path.items():
        items.sort(key=lambda f: f["line"] if f["line"] is not None else -1)
        current = []
        for f in items:
            if current and f["line"] is not None and current[-1]["line"] is not None \
                    and f["line"] - current[-1]["line"] <= SAME_FILE_LINE_WINDOW:
                current.append(f)
            else:
                if current:
                    clusters.append(current)
                current = [f]
        if current:
            clusters.append(current)
    return clusters


def main():
    if len(sys.argv) < 4:
        print(__doc__)
        sys.exit(1)
    owner, repo, pr_number = sys.argv[1], sys.argv[2], sys.argv[3]
    pin_sha = sys.argv[4] if len(sys.argv) > 4 else None

    raw_comments = gh_api(f"repos/{owner}/{repo}/pulls/{pr_number}/comments")

    parsed = []
    unparsed = []
    for c in raw_comments:
        tool = REVIEWER_LOGINS.get(c["user"]["login"])
        if tool is None:
            continue
        result = PARSERS[tool](c["body"])
        if result is None:
            unparsed.append((tool, c["id"]))
            continue
        parsed.append({
            "reviewer_tool": tool,
            "path": c["path"],
            "line": c.get("original_line"),
            "commit_id": c["original_commit_id"],
            "created_at": c["created_at"],
            **result,
        })

    if not parsed:
        print(f"No parseable {'/'.join(REVIEWER_LOGINS.values())} findings on this PR.")
        return

    boundary_sha = pin_sha or max(parsed, key=lambda p: p["created_at"])["commit_id"]
    boundary_findings = [p for p in parsed if p["commit_id"] == boundary_sha]

    print(f"# Multi-reviewer summary — {owner}/{repo}#{pr_number} @ {boundary_sha[:12]}\n")

    reviewers_present = sorted({f["reviewer_tool"] for f in boundary_findings})
    print(f"Reviewers on this commit: {', '.join(reviewers_present)}\n")

    clusters = cluster_same_file(boundary_findings)
    clusters.sort(key=lambda cl: (cl[0]["path"], cl[0]["line"] or -1))

    # Clusters from other reviewers in the SAME file, outside the tight
    # window, are not auto-merged (a wider window risks false-positive
    # merges of genuinely unrelated findings) — but silently calling them
    # "unique" would be worse: it asserts independence the data doesn't
    # support. Flag them as unconfirmed instead of picking a side.
    clusters_by_path = defaultdict(list)
    for cl in clusters:
        clusters_by_path[cl[0]["path"]].append(cl)

    any_major = False
    for cluster in clusters:
        reviewers_in_cluster = sorted({m["reviewer_tool"] for m in cluster})
        tier = "major" if any(m["tier"] == "major" for m in cluster) else "minor"
        any_major = any_major or tier == "major"
        agreement = "corroborated (auto-matched, same file)" if len(reviewers_in_cluster) > 1 else "unique"
        path = cluster[0]["path"]
        lines = ",".join(str(m["line"]) for m in cluster if m["line"] is not None)
        print(f"### {path}:{lines} — {tier} ({agreement})")
        for m in cluster:
            print(f"- **{m['reviewer_tool']}** ({m['raw_severity']}): "
                  f"{(m['title'] or m['summary'])[:160]}")
        others_in_file = [
            c for c in clusters_by_path[path]
            if c is not cluster and not set(reviewers_in_cluster) & {m["reviewer_tool"] for m in c}
        ]
        for other in others_in_file:
            other_lines = ",".join(str(m["line"]) for m in other if m["line"] is not None)
            print(f"  ⚠ possibly related — {sorted({m['reviewer_tool'] for m in other})[0]} also "
                  f"flagged this file at line(s) {other_lines}; too far apart to auto-merge, "
                  f"not confirmed as the same defect")
        print()

    if unparsed:
        print(f"({len(unparsed)} comment(s) from configured reviewers didn't match a known "
              f"format — not included above; check manually: "
              f"{', '.join(f'{t}#{i}' for t, i in unparsed)})\n")

    print("---")
    if any_major:
        print("**At least one major (P0/P1-tier) finding present — needs human confirmation "
              "before this can be `agent-clear`.**")
    else:
        print("No major-tier findings from configured reviewers on this commit. This is *not* "
              "a PR-level `agent-clear` determination — that stays a separate, manual judgment "
              "per AGENTS.md's merge-readiness checklist (see multi-reviewer-matching.md #10).")
    print("Cross-file and cross-boundary matches are not auto-detected by this script — if a "
          "finding here looks related to something flagged on an earlier commit, confirm by hand.")


if __name__ == "__main__":
    main()
