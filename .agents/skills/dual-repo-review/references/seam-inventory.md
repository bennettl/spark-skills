# Seam inventory

Every place the two repos touch, and **who owns checking it**. The point of this
file is the ownership column: three of these seams are covered by an existing
skill, and three are covered by nothing until this skill checks them.

| # | Seam | Owner |
|---|------|-------|
| 1 | REST request/response field shapes | **`api-contract-check`** — delegate |
| 2 | Response envelope + pagination depth | **`api-contract-check`** — delegate |
| 3 | Per-repo rules (guards, invalidation, DTO classes, …) | **`self-review`** — delegate |
| 4 | **Event contract (`EventType` + `CourseEvent`)** | **this skill** — nothing else checks it |
| 5 | **Enum / const parity** | **this skill** |
| 6 | **Endpoint-map ↔ route coverage (orphan detection)** | **this skill** |

---

## 4. The event contract — the uncovered one

Verified on `main` in both repos. This is a **hand-mirrored contract**, exactly like
the API types, with the same silent-drift failure mode — and `api-contract-check`
does not cover it, because it only compares REST request/response shapes.

**Two artifacts, duplicated verbatim across repos:**

| | spark-api | spark-web |
|---|---|---|
| `EventType` enum | `src/events/const/event-types.const.ts` | `src/hooks/use-event-invalidation.ts` |
| `CourseEvent` payload | `src/events/dto/events.dto.ts` | `src/hooks/use-event-invalidation.ts` |

The backend file even labels the payload `// WebSocket payload (FE-facing)`,
distinguishing it from the internal `EventEmitter2` payloads below it. Delivery is
socket.io via `src/events/gateway/events.gateway.ts`.

Read both files directly for the current member list and payload shape — any
count or member list written here would be stale the moment either side changes,
and the whole point of this seam is that they drift silently.

**What to check when a diff touches either side:**

- **Added event on the backend, absent from the frontend enum** → the frontend's
  `handleCourseEvent` switch has no case for it, so nothing invalidates. The UI goes
  stale with **no error anywhere**. High severity: it is invisible in testing unless
  you specifically exercise the flow that emits.
- **Renamed event** → string-matched on both sides, so a rename that isn't mirrored
  silently stops matching. Blocker if the event drove an invalidation users depend on.
- **Removed event still handled on the frontend** → dead switch case. Low, but
  worth noting so it gets cleaned.
- **`CourseEvent` payload field added/renamed** → the frontend reads
  `event.assignmentId` / `event.entityId` to decide *which* `QueryKey` to
  invalidate. A payload change can make invalidation target the wrong key, which
  looks like a caching bug, not an event bug.
- **New event added but wired to the wrong `QueryKey`(s)** → read the switch case
  and confirm it invalidates every key that renders the affected data. Note the
  frontend has more than one key namespace: the main `QueryKey` map from
  `@/api/const` plus module-local ones like `ProposalQueryKey` from `@/api/proposals`.

**Do not flag:** the internal `EventEmitter2` payload interfaces in the backend's
`events.dto.ts` (`JobTrackerCompletedEvent`, `JobFinishedEvent`,
`ProposalCreatedEvent`, …). They are explicitly backend-only and are not part of the
seam. Also do not flag `CourseEvent` for being an `interface` rather than a
class-validator class — `self-review`'s "DTOs must be decorated classes" rule is
about **inbound request** DTOs; this is an **outbound** payload, so an interface is
correct here.

## 5. Enum / const parity

The backend keeps per-feature `enum.ts` files (e.g. `src/assignment/enum.ts`,
`src/process-insight/enum.ts`). The frontend mirrors these as literal unions,
enums, or hand-written constants inside its api modules.

- Verify every enum member the backend adds/renames/removes is mirrored, including
  the **string values**, not just the member names.
- A backend enum widened with a new member that the frontend doesn't know about
  means the frontend hits a value it has no branch for — often rendering blank or
  falling through a `switch` default.
- Also check queue/messaging constants (`libs/messaging/src/const.ts`) when the
  diff touches them — these are backend-internal, but a rename there pairs with
  infrastructure (see `deploy-ordering.md`), not with the frontend.

## 6. Endpoint-map ↔ route coverage (orphan detection)

Neither spoke can see an orphan, because each only sees one side.

- **Every new backend route** should have a frontend `Endpoint` entry consuming it,
  **or** an explicit reason it doesn't yet (internal, webhook, future work). An
  unconsumed new route isn't automatically wrong — an unconsumed new route nobody
  *noticed* is.
- **Every new frontend `Endpoint` entry** must resolve to a real backend route.
  Verified at the time of writing: spark-api's `main.ts` sets **neither
  `setGlobalPrefix` nor `enableVersioning`** (both absent), so a plain path match
  works today. Re-check before trusting that — if either is ever added, an
  unprefixed match silently fails and you report a **false orphan**, which is worse
  than missing one.
- **Every new backend controller** needs `@UseInterceptors(ResponseInterceptor)`,
  or it returns a bare payload and the frontend's `res.data.data` unwrap yields
  `undefined`. This is cheap to check and silent when wrong, which is why it lives
  in the seam list even though it's a single-repo fact.
- **Webhooks are inbound, not seam.** Third-party-called routes have no frontend
  consumer *by design* — e.g. `@Post('webhooks/sendgrid/inbound')` at
  `src/inbound-email/inbound-email.controller.ts:64`, which the code itself
  annotates "(public, no auth)". Stripe billing has a webhook route too. Never
  report these as orphans, and don't flag them as unguarded — public is intentional
  here (verify the signature check instead, if the diff touches one).

## Naming: match on endpoints, never on names

The two repos do not use the same vocabulary for the same feature. A real example
from the Process Insights pair: the backend module is `src/process-insight/`
(singular) and the frontend api module is `src/api/process-insights.ts` (plural).
Other observed divergences: singular backend entity versus plural frontend list
module, and backend feature directories that map to several frontend page folders.

Match the pair on the **endpoint path** and the **feature vocabulary inside the
diff**. A name-based match produces confident false negatives — the worst output
class, because "no sibling found" reads as a finding.
