# Main-branch protection checklist

Apply this ruleset to `main` in `bennettl/spark-api`, `bennettl/spark-web`, and
`bennettl/spark-skills`. The current automation account has push/triage access
but not repository administration, so an owner must configure it in GitHub.

- Enforcement: active; target the default branch `main` only.
- Require a pull request before merging.
- Required approvals: 1, from someone other than the author.
- Dismiss stale approvals when new commits are pushed.
- Require conversation resolution.
- Require status check: `Build` for the app repos and `Registry` for
  `spark-skills` (each from GitHub Actions workflow `CI`), pinned to the GitHub
  Actions source where GitHub exposes an app/source selector. Confirm a
  successful `main` run exists first.
- Require branches to be up to date before merging.
- Block force pushes and branch deletion.
- Do not allow bypass for ordinary contributors or review bots.
- Do not count any configured automatic reviewer's bot account as the human
  approval. Known bot logins as of this writing:

  | reviewer | app name (GitHub branch-protection UI) | API login (ledgers, `gh api`) |
  |---|---|---|
  | Codex | `chatgpt-codex-connector` | `chatgpt-codex-connector[bot]` |
  | Claude | `claude` | `claude[bot]` |

  Two forms, both real: branch-protection's bypass-list search matches the
  app name without the `[bot]` suffix, while every ledger and `gh api` call in
  this pilot records the API login *with* the suffix (see
  `reviewer-attempt-ledger.csv`'s `reviewer_identity` column). Use the app
  name when configuring the GitHub UI; don't read the difference as an
  inconsistency between this table and the ledgers. Add a row here, and
  confirm the branch-protection ruleset still excludes it, before trusting any
  additional automatic reviewer as advisory-only.
- Keep auto-merge disabled during the pilot.

Verify with two disposable, never-merged PRs: one intentionally breaks the
build and one has a green build but no human approval. Neither may merge. Do not
apply the ruleset to intermediate stack bases (`bl/**`, `sl/**`, `feat/**`, or
similar) initially; they keep advisory CI/review while the final `main` boundary
is enforced.

The final PR (or consolidation PR) into `main` must contain the complete intended
stack, pass its current required check, and receive a fresh other-human approval.
Any base movement invalidates the recorded reviewer result until a fresh review
covers the new boundary.

The committed `CODEOWNERS` paths provide notification/automatic review requests
during the pilot; code-owner approval is not required. No automatic reviewer in
the bot-login table above ever counts as the human approver.
