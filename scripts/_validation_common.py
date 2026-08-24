"""Shared accumulate-and-report scaffolding for this repo's validator scripts
(validate.py, validate_reviewer_ledgers.py).

A Reporter instance, not module-level globals, so two validators can run in
the same process (e.g. a future combined CLI or test harness) without
pooling errors/warnings across scripts.
"""


class Reporter:
    def __init__(self):
        self.errors = []
        self.warnings = []

    def fail(self, msg):
        self.errors.append(msg)

    def warn(self, msg):
        self.warnings.append(msg)

    def report(self, warn_prefix, fail_prefix, summary):
        """Print accumulated warnings then errors, then a summary line.
        Returns 1 if there were any errors, 0 otherwise — callers decide
        whether/when to sys.exit() with it."""
        for w in self.warnings:
            print(f"{warn_prefix}{w}")
        for e in self.errors:
            print(f"{fail_prefix}{e}")
        print(f"\n{summary}: {len(self.errors)} error(s), {len(self.warnings)} warning(s).")
        return 1 if self.errors else 0
