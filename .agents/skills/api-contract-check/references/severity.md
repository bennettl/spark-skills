# Severity classification

Rank by runtime consequence, not by how easy the fix is.

## blocker — runtime crash or wrong data written

The mismatch causes an exception or persists incorrect data.
- FE sends a field the DTO rejects (fails validation → 400 the FE doesn't handle),
  or omits a required `@Body` field.
- FE writes to a field name the BE doesn't read, so the value is silently dropped
  on a create/update (data loss).
- Type mismatch that throws on parse (FE `z.number()` against a `numeric` column
  serialized as a string → zod throws).

## high — silently wrong data shown to the user

No crash, but the user sees or acts on incorrect data.
- Nullable column typed as non-null on the FE → `null` renders as "null"/blank or
  breaks a downstream computation.
- Missing envelope: FE reads `response.foo` when the wire is `{ data: { foo } }`
  → `undefined` shown as empty.
- Enum drift: BE adds an enum value the FE union doesn't list → unhandled case.
- Wrong pagination shape → only the first page ever renders.

## medium — type-unsafe but currently tolerated

Works today, fragile tomorrow.
- `Date` typed as `Date` on the FE but arriving as an ISO string (works until
  someone calls a `Date` method on it).
- Optional-vs-nullable confusion on a field that happens to always be present now.
- `numeric` typed as `number` that currently parses because values are small.

## low — cosmetic / no behavioral impact

- Field description or JSDoc drift.
- Ordering differences.
- A currently-aligned field the diff touched — report as a one-line "verified
  aligned," not as a finding to fix.

## Assigning severity

Ask: *what happens at runtime when this exact mismatch is hit?* Crash or bad
write → blocker. Wrong data surfaced → high. Fragile-but-works → medium.
No behavior change → low. When between two levels, pick the higher and say why.
