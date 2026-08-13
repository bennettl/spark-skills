# Merge and deploy ordering

Both repos deploy to Heroku, independently. Two merges means two deploys, and
between them **production runs one new half against one old half**. That window is
where dual-repo changes actually break, and no single-repo gate can see it.

Answer four questions, in this order.

## 1. Which half lands first?

**Backend first, almost always.** A frontend calling a route that doesn't exist yet
gets a 404; a backend exposing a route nobody calls yet is inert. So the default
sequence is: merge + deploy spark-api, verify, then merge + deploy spark-web.

State it explicitly anyway, because there are real exceptions:

- **Frontend-only mirror of an already-shipped backend** — the backend contract is
  already live, so the frontend can land alone. Say so.
- **Backend change that is *not* backward-compatible** (see §3) — then neither
  order is safe on its own, and the fix is to make the backend compatible first,
  not to pick a different order.
- **A removal.** Deleting a route or field inverts the order: the **frontend** must
  stop calling it first, then the backend removes it. Getting this backwards is a
  guaranteed production error, and it's the single most common ordering mistake.

## 2. What does the backend deploy mutate?

`synchronize: true`, no migrations — **every entity edit is a live schema change on
the next deploy.**

**Ownership:** whether a given entity edit is *safe* is `self-review`'s call — its
`spark-api-checks.md` §2 owns the destructive-change trap, the backfill question,
and the severity mapping. Take that verdict as given; don't re-litigate it. What
this skill adds is the **ordering and blast-radius consequence across two deploys**:
which changes must land before the frontend, and what production looks like in
between. The table below is a sequencing aid for that judgment, not a second
severity rubric — if it ever disagrees with `spark-api-checks.md` §2, that file
wins and this one is the bug.

| Change | Risk | Notes |
|---|---|---|
| **New entity** (new table) | Additive, safe | No existing data to lose |
| **New nullable column** | Additive, safe | Backfill optional |
| **New non-nullable column** without a default | **Destructive risk** | Fails or forces a value on existing rows |
| **Widened type / longer varchar** | Usually safe | Verify Postgres allows in-place |
| **Narrowed type** | **Destructive** | Truncation or cast failure |
| **Nullable → non-nullable** | **Destructive** | Fails if any row holds NULL |
| **Renamed column** | **Destructive — drop + add** | Old column's data is gone; needs additive-then-migrate |
| **Removed column** | **Destructive** | Data gone, unrecoverable without a backup |

Report the count and the classification. A pair touching several entity files
deserves this spelled out per file — "7 entity files changed" is not a review, "3
new tables plus 4 edits to existing entities, of which one narrows a type" is.

Where a change is destructive, the fix direction is normally **additive first**:
add the new column, backfill via `scripts/*.sql` or a dated `onetime/*` script run
manually with `pnpm execute`, cut over reads, then drop the old column in a later
deploy. Do not propose rename-in-place.

## 3. Is the backend backward-compatible with the *old* frontend?

**This is the question nobody asks, and the most common way a dual-repo change
breaks production.** After the backend deploys and before the frontend does, live
users are running the old frontend bundle against the new backend.

Check whether the backend change is additive from the old frontend's point of view:

- **Added field / added route / added optional param** → compatible. Old frontend
  ignores it.
- **Renamed field** → **breaks**. The old frontend reads the old name and gets
  `undefined`, with no runtime validation to catch it (zod never validates
  responses). Silent blank UI for every user until the frontend deploys.
- **Field that became nullable** → **likely breaks**. The old frontend doesn't
  null-guard it.
- **Removed field, removed route, tightened validation, new required param** →
  **breaks**.
- **Changed envelope** (adding or removing `ResponseInterceptor` on an existing
  controller) → **breaks**, and in a way that looks like a total outage of that
  view.

If the backend is not backward-compatible, say so and state the consequence
plainly: *"between the two deploys, every user on the old bundle sees X."* The
remedy is usually to make the backend accept both shapes for one release, then
narrow after the frontend ships. Deploying "quickly, back to back" is not a
remedy — it just shortens the outage.

Always state the window's status, even when it's fine: **"compatible — additive
only, no window risk"** is a valid and useful line.

## 4. Are there out-of-band prerequisites?

Things that must happen *outside* the two merges, before the backend boots. A
consumer registered against a queue that doesn't exist fails at **runtime**, not at
build — so nothing in either repo's gate catches it.

- **Queue provisioning.** New SQS queues need creating before the consumers that
  read them start. The reliable signal in the diff is a **new queue constant in
  `libs/messaging/src/const.ts`** plus a new consumer registered in
  `app.module.ts`. A provisioning script may accompany it — the Process Insights
  pair introduces `scripts/setup-queue.sh`, which does **not** exist on `main`, so
  treat such a script as a per-change artifact to look for, not an established
  convention to expect. Heavy async work (grading, PDF→image, scanning, insights,
  regrade) all runs through these consumers.
- **Data backfill.** `scripts/*.sql` or a dated `onetime/*` script, run manually via
  `pnpm execute`. If the diff adds one, it is part of the deploy sequence — say
  where it goes (usually: after the schema change, before the frontend cuts over).
- **New env vars / secrets.** App boot **requires `DATABASE_URL`** and throws
  without it; other integrations (Stripe, SendGrid, AWS, LTI, the LLM providers)
  read from the environment. A diff that reads a new env var needs it set on Heroku
  first. Name the variable; never print a value.
- **Third-party config.** LTI/LMS registrations, Stripe webhook endpoints, Cognito
  app-client settings.

## Output

Fold the answers into a **sequenced merge plan** in the report — an ordered list a
person can execute, with the verification step between each:

1. Provision the new SQS queue (`scripts/setup-queue.sh`) — before any deploy.
2. Merge + deploy **spark-api** #N. Schema effect: 3 new tables, 1 nullable column
   added to `assignment`. Additive; no data-loss risk.
3. Verify: `GET /process-insights?...` returns `{ "data": … }`; the consumer logs a
   successful poll.
4. Merge + deploy **spark-web** #M.
5. Discover and run the checks available in the target spark-web branch's
   package scripts and CI configuration, then perform risk-specific browser
   verification. Record exact commands/results and explicitly state any changed
   behavior that has no automated coverage.

Deploy window: **compatible.** Backend changes are additive, so the old frontend
bundle is unaffected between steps 2 and 4.
