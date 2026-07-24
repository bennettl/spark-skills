# Model currency

The registry must not rot as models change. This is a first-class concern: the
prior origin repo went stale partly because skills baked in assumptions about
specific models and context sizes.

## Two failure modes

1. **Stale references** — a skill (or its references) names a deprecated model ID
   (`claude-3-*`, `gpt-4-*`, `text-davinci-*`) or a hardcoded context window
   (`8k`/`100k`/`200k tokens`) that no longer holds.
2. **Unknown-latest** — the *newest* model shipped and the registry (or a tool it
   trusts) doesn't know about it. This one bit us during this very build:
   Claude **Opus 5** (`claude-opus-5`) launched 2026-07-24, and the bundled model
   reference we consulted had been cached 2026-06-24 — a month stale — so it
   reported Opus 5 didn't exist. A hardcoded roster is stale the moment a model
   ships.

## What the validator checks (warn-only)

`scripts/validate.py` greps skill bodies + references for stale-ID patterns and
token-adjacent context-window literals, and prints file:line warnings. Warn-only
by design — a skill legitimately discussing an old model shouldn't fail the build.

## What the `audit` meta-skill must do (when built)

Do **not** re-implement the currency check as a hardcoded allow-list of "current"
models — that list is the thing that goes stale. Instead, the audit should fetch
**ground truth** at run time and diff the registry against it:

- Query the Claude Models API (`GET /v1/models`, or `client.models.list()`), or
  fetch the models-overview doc, to get the live current-model set.
- Flag any skill that references a model the live set marks deprecated/retired.
- Confirm the registry's own defaults/examples name models the live set still
  serves; surface newly-released models the registry hasn't accounted for.

Run the audit on every major model release (Opus 5 being the trigger that
motivated this note). The lesson from Opus 5: **verify against a live source, not
a baked-in list.**
