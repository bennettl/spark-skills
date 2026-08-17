#!/usr/bin/env python3
"""Validate the reviewer-pilot ledgers: column-count integrity, enum
membership, and cross-ledger references (attempt_id, matched_finding_id,
reviewer_tool consistency, one canonical attempt per reviewer per boundary).

Stdlib only. Run: `python3 scripts/validate_reviewer_ledgers.py` (or
`just validate-ledgers`). Exits non-zero on any hard failure; warnings never
fail the build. This does not check the ledgers' factual accuracy against
GitHub — only their internal structure. A clean run is not evidence any row's
SHA, line number, or review ID is correct; those require independent
verification against the source (see `meta/multi-reviewer-matching.md`).
"""

import csv
import os
import sys
from collections import Counter, defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
META = os.path.join(ROOT, "meta")

ATTEMPT_LEDGER = os.path.join(META, "reviewer-attempt-ledger.csv")
FINDING_LEDGER = os.path.join(META, "reviewer-finding-ledger.csv")
SEED_LEDGER = os.path.join(META, "reviewer-seed-ledger.csv")

BOOL_VALUES = {"", "TRUE", "FALSE"}
OUTCOME_VALUES = {"", "agent-clear", "blocker", "human-review"}
NON_COMPLETION_VALUES = {
    "",
    "quota_exhausted",
    "error",
    "stale_superseded",
    "policy_unavailable",
    "context_unavailable",
}
SEVERITY_VALUES = {"P0", "P1", "P2", "P3"}
SOURCE_VALUES = {"model", "human"}
MATCH_METHOD_VALUES = {
    "",
    "same_file_same_line",
    "same_file_diff_line",
    "cross_file_semantic",
}
MATCH_CONFIDENCE_VALUES = {"", "high", "medium", "low"}
CROSS_REVIEWER_STATUS_VALUES = {
    "",
    "unique",
    "corroborated",
    "duplicate_confirmed",
    "duplicate_rejected",
}
ADJUDICATION_VALUES = {
    "",
    "confirmed",
    "false_finding",
    "missed_issue",
    "pre_existing",
    "out_of_scope",
}
# Known reviewer tools as of this writing, including the synthetic "human"
# attempt row a human-sourced finding attaches to (see reviewer_tool cross-
# check below). Not enforced as a hard failure — a new automatic reviewer
# being added is expected; typos in an existing one are not.
KNOWN_REVIEWER_TOOLS = {"codex", "claude", "human"}

errors = []
warnings = []


def fail(msg):
    errors.append(msg)


def warn(msg):
    warnings.append(msg)


def read_rows(path):
    if not os.path.exists(path):
        fail(f"{path}: file does not exist")
        return None, []
    with open(path, newline="") as fh:
        rows = list(csv.reader(fh))
    if not rows:
        fail(f"{path}: empty file, missing header")
        return None, []
    header = rows[0]
    data_rows = rows[1:]
    for i, row in enumerate(data_rows, start=2):  # +1 header, +1 1-indexed
        if len(row) != len(header):
            fail(
                f"{path}:{i}: has {len(row)} fields, header declares "
                f"{len(header)}"
            )
    dicts = [
        dict(zip(header, row)) for row in data_rows if len(row) == len(header)
    ]
    return header, dicts


def require_columns(path, header, columns):
    """Fail if any of `columns` is entirely absent from the header. Without
    this, check_enum()'s row.get(column, "") makes a *missing* column
    indistinguishable from every row correctly leaving it blank, for any
    enum whose allowed set includes "" — which is most of them."""
    missing = [c for c in columns if c not in header]
    if missing:
        fail(f"{path}: missing required column(s): {missing}")


def check_enum(path, rows, column, allowed, row_key="finding_id"):
    for row in rows:
        val = row.get(column, "")
        if val not in allowed:
            fail(
                f"{path}: {row.get(row_key, '?')}.{column}={val!r} not in "
                f"{sorted(allowed)}"
            )


def main():
    attempt_header, attempts = read_rows(ATTEMPT_LEDGER)
    finding_header, findings = read_rows(FINDING_LEDGER)
    seed_header, seeds = read_rows(SEED_LEDGER)

    if attempt_header is None or finding_header is None:
        _report()
        return

    attempt_id_counts = Counter(a["attempt_id"] for a in attempts)
    finding_id_counts = Counter(f["finding_id"] for f in findings)
    for aid, count in attempt_id_counts.items():
        if count > 1:
            fail(f"{ATTEMPT_LEDGER}: attempt_id={aid!r} appears on {count} rows, must be unique")
    for fid, count in finding_id_counts.items():
        if count > 1:
            fail(f"{FINDING_LEDGER}: finding_id={fid!r} appears on {count} rows, must be unique")

    attempt_ids = set(attempt_id_counts)
    finding_ids = set(finding_id_counts)

    require_columns(
        ATTEMPT_LEDGER,
        attempt_header,
        [
            "is_canonical_for_boundary",
            "stale",
            "eligible",
            "outcome",
            "non_completion_reason",
            "reviewer_tool",
        ],
    )
    require_columns(
        FINDING_LEDGER,
        finding_header,
        [
            "severity",
            "source",
            "match_method",
            "match_confidence",
            "cross_reviewer_status",
            "adjudication",
            "reviewer_tool",
        ],
    )

    # --- attempt ledger checks ---
    check_enum(ATTEMPT_LEDGER, attempts, "is_canonical_for_boundary", BOOL_VALUES, "attempt_id")
    check_enum(ATTEMPT_LEDGER, attempts, "stale", BOOL_VALUES, "attempt_id")
    check_enum(ATTEMPT_LEDGER, attempts, "eligible", BOOL_VALUES, "attempt_id")
    check_enum(ATTEMPT_LEDGER, attempts, "outcome", OUTCOME_VALUES, "attempt_id")
    check_enum(
        ATTEMPT_LEDGER,
        attempts,
        "non_completion_reason",
        NON_COMPLETION_VALUES,
        "attempt_id",
    )
    for a in attempts:
        if a.get("reviewer_tool", "") not in KNOWN_REVIEWER_TOOLS:
            warn(
                f"{ATTEMPT_LEDGER}: {a['attempt_id']}.reviewer_tool="
                f"{a.get('reviewer_tool')!r} is not in the known set "
                f"{sorted(KNOWN_REVIEWER_TOOLS)} — fine if this is a newly "
                "added reviewer, a typo otherwise"
            )
        if not a.get("non_completion_reason") and not a.get("outcome"):
            fail(
                f"{ATTEMPT_LEDGER}: {a['attempt_id']} has no "
                "non_completion_reason and no outcome — a completed attempt "
                "must record an outcome (agent-clear/blocker/human-review)"
            )
        if a.get("non_completion_reason") and a.get("outcome") != "human-review":
            fail(
                f"{ATTEMPT_LEDGER}: {a['attempt_id']} has "
                f"non_completion_reason={a.get('non_completion_reason')!r} but "
                f"outcome={a.get('outcome')!r} — both docs state a "
                "non_completion_reason attempt 'still resolves to' "
                "human-review; the mirror of the blank-outcome check above"
            )

    # exactly one canonical attempt per (repository, pr_url, reviewer_tool,
    # merge_base_sha, reviewed_head_sha) boundary. repository/pr_url are part
    # of the key because merge_base_sha/reviewed_head_sha alone could — in
    # principle, e.g. a SHA-1 collision or a shared history between repos —
    # coincide across two unrelated PRs; the key should identify one PR's
    # boundary, not just one commit pair.
    #
    # Grouped from ALL attempts sharing a boundary (not just TRUE-flagged
    # ones), so a boundary where every attempt is FALSE — zero canonical,
    # not just "not more than one" — is inspected too. A boundary is only
    # required to have a canonical attempt once at least one attempt on it
    # resolved to a real outcome (non-blank); one still in flight (blank
    # outcome, no non_completion_reason yet) doesn't need one yet, though
    # that state itself already fails the blank-outcome check above.
    boundary_groups = defaultdict(list)
    for a in attempts:
        key = (
            a.get("repository"),
            a.get("pr_url"),
            a.get("reviewer_tool"),
            a.get("merge_base_sha"),
            a.get("reviewed_head_sha"),
        )
        boundary_groups[key].append(a)
    for key, group in boundary_groups.items():
        canonical_ids = [
            a["attempt_id"] for a in group if a.get("is_canonical_for_boundary") == "TRUE"
        ]
        if len(canonical_ids) > 1:
            fail(
                f"{ATTEMPT_LEDGER}: boundary {key} has {len(canonical_ids)} "
                f"attempts marked canonical ({canonical_ids}) — must be "
                "exactly one"
            )
        elif not canonical_ids and any(
            a.get("outcome") and not a.get("non_completion_reason") for a in group
        ):
            # A non-blank outcome alone isn't "completed" — the mirror
            # invariant above forces outcome=human-review whenever
            # non_completion_reason is set, so a quota-exhausted attempt
            # that never ran a review would otherwise trip this. Only an
            # attempt with a resolved outcome AND no non_completion_reason
            # is a real completed review requiring a canonical row.
            fail(
                f"{ATTEMPT_LEDGER}: boundary {key} has a completed review "
                f"but no attempt marked is_canonical_for_boundary=TRUE "
                f"({[a['attempt_id'] for a in group]}) — must be exactly one"
            )

        # canonical must be the LATEST completed attempt on the boundary, not
        # merely "the one flagged" — multi-reviewer-matching.md defines it as
        # "the last completed review". "Completed" here means the same
        # outcome-without-non_completion_reason test used above.
        completed = [
            a for a in group
            if a.get("outcome") and not a.get("non_completion_reason") and a.get("completed_at")
        ]
        if len(canonical_ids) == 1 and completed:
            canonical_row = next(a for a in group if a["attempt_id"] == canonical_ids[0])
            latest = max(completed, key=lambda a: a["completed_at"])
            if canonical_row.get("completed_at") < latest["completed_at"]:
                fail(
                    f"{ATTEMPT_LEDGER}: boundary {key} marks {canonical_ids[0]} "
                    f"canonical (completed_at={canonical_row.get('completed_at')!r}) "
                    f"but {latest['attempt_id']} completed later "
                    f"({latest['completed_at']!r}) — canonical must be the "
                    "latest completed attempt"
                )

    # --- finding ledger checks ---
    check_enum(FINDING_LEDGER, findings, "severity", SEVERITY_VALUES)
    check_enum(FINDING_LEDGER, findings, "source", SOURCE_VALUES)
    check_enum(FINDING_LEDGER, findings, "match_method", MATCH_METHOD_VALUES)
    check_enum(FINDING_LEDGER, findings, "match_confidence", MATCH_CONFIDENCE_VALUES)
    check_enum(
        FINDING_LEDGER, findings, "cross_reviewer_status", CROSS_REVIEWER_STATUS_VALUES
    )
    check_enum(FINDING_LEDGER, findings, "adjudication", ADJUDICATION_VALUES)

    attempts_by_id = {a["attempt_id"]: a for a in attempts}
    findings_by_id = {f["finding_id"]: f for f in findings}
    for f in findings:
        aid = f.get("attempt_id", "")
        if aid not in attempt_ids:
            fail(f"{FINDING_LEDGER}: {f['finding_id']}.attempt_id={aid!r} has no matching attempt row")
            continue
        parent = attempts_by_id[aid]
        if f.get("reviewer_tool") != parent.get("reviewer_tool"):
            fail(
                f"{FINDING_LEDGER}: {f['finding_id']}.reviewer_tool="
                f"{f.get('reviewer_tool')!r} does not match parent attempt "
                f"{aid}.reviewer_tool={parent.get('reviewer_tool')!r}"
            )
        mid = f.get("matched_finding_id", "")
        if mid:
            if mid == f["finding_id"]:
                fail(f"{FINDING_LEDGER}: {f['finding_id']}.matched_finding_id points to itself")
            elif mid not in finding_ids:
                fail(
                    f"{FINDING_LEDGER}: {f['finding_id']}.matched_finding_id="
                    f"{mid!r} has no matching finding row"
                )
            elif (
                f.get("cross_reviewer_status") != "duplicate_rejected"
                and f.get("root_cause_key") != findings_by_id[mid].get("root_cause_key")
            ):
                # A rejected match is the documented exception: step 5 of the
                # matching procedure has a rejected match keep its
                # matched_finding_id pointer but split into its own
                # root_cause_key, since rejection means they do NOT share a
                # root cause. Every other status asserts they do.
                fail(
                    f"{FINDING_LEDGER}: {f['finding_id']}.root_cause_key="
                    f"{f.get('root_cause_key')!r} does not match matched "
                    f"finding {mid}.root_cause_key="
                    f"{findings_by_id[mid].get('root_cause_key')!r}"
                )
        status = f.get("cross_reviewer_status", "")
        if status in {"duplicate_confirmed", "duplicate_rejected"} and not mid:
            fail(
                f"{FINDING_LEDGER}: {f['finding_id']} has cross_reviewer_status="
                f"{status!r} but no matched_finding_id"
            )
        if status in {"corroborated", "duplicate_confirmed", "duplicate_rejected"} and not f.get(
            "adjudicated_by"
        ):
            fail(
                f"{FINDING_LEDGER}: {f['finding_id']}.cross_reviewer_status="
                f"{status!r} but adjudicated_by is blank — multi-reviewer-"
                "matching.md requires the same maintainer sign-off for all "
                "three of these statuses, never set from the matcher's "
                "proposal alone"
            )

    # --- seed ledger checks ---
    # The column-existence check runs even when there are zero data rows yet
    # (the real ledger currently is header-only) — gating it on `and seeds`
    # would make it silently unable to ever fire until the first seed is
    # recorded, which is exactly backwards for a schema check.
    if seed_header is not None:
        if "reviewer_tool" not in seed_header:
            fail(
                f"{SEED_LEDGER}: missing reviewer_tool column — a seed's "
                "result is now per-reviewer, not per-seed"
            )
        for s in seeds:
            aid = s.get("attempt_id", "")
            if aid:
                if aid not in attempt_ids:
                    fail(
                        f"{SEED_LEDGER}: {s.get('seed_id', '?')}.attempt_id="
                        f"{aid!r} has no matching attempt row"
                    )
                elif s.get("reviewer_tool") != attempts_by_id[aid].get("reviewer_tool"):
                    fail(
                        f"{SEED_LEDGER}: {s.get('seed_id', '?')}.reviewer_tool="
                        f"{s.get('reviewer_tool')!r} does not match linked "
                        f"attempt {aid}.reviewer_tool="
                        f"{attempts_by_id[aid].get('reviewer_tool')!r}"
                    )
            ofid = s.get("observed_finding_id", "")
            if ofid and ofid not in finding_ids:
                fail(
                    f"{SEED_LEDGER}: {s.get('seed_id', '?')}.observed_finding_id="
                    f"{ofid!r} has no matching finding row"
                )

    _report()


def _report():
    for w in warnings:
        print(f"WARNING: {w}")
    for e in errors:
        print(f"ERROR: {e}")
    print(f"\nChecked reviewer ledgers: {len(errors)} error(s), {len(warnings)} warning(s).")
    if errors:
        sys.exit(1)


if __name__ == "__main__":
    main()
