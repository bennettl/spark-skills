# spark-web review checklist

The frontend rule set, highest-value first. Each item: **what to look for** in the
diff, **why it bites**, and the **severity** it maps to (see `report-template.md`).
These mirror spark-web's `AGENTS.md` "Code Review Rules" and "Non-obvious rules a
contributor MUST know" — read that file too; where it differs, it wins.

Ground truth for this repo: TS strictness is **on**, but that doesn't help the
biggest risk — the API types are **hand-written to mirror the backend, with no
codegen and no shared package**, and **zod does not validate responses**
(`.parse`/`.safeParse` appear nowhere in `src/api`). A backend field
rename/nullability change compiles fine and only surfaces as a runtime bug.

## 1. API types in sync with the backend — route to api-contract-check

The top review priority. Because types are hand-written and zod doesn't validate,
FE↔BE drift is the single biggest source of bugs.

- Look for: any diff hunk in an `src/api/*` module — a request/response
  `interface`, a new/changed endpoint, or a zod schema.
- Action: **recommend the `api-contract-check` skill** with the touched
  endpoint(s) as scope. Do **not** hand-diff FE types against the backend here —
  that is exactly what api-contract-check does, and duplicating it lets the two
  drift. When spark-api isn't checked out, note the single-repo degrade
  (Endpoint-map↔module coverage, and zod-schema↔interface within the repo) and
  flag the risk anyway.
- Severity: verify field name, type, optionality, nullability, enum values,
  casing (camelCase both sides), date/number serialization. Any mismatch on a
  write path → blocker; on a read path → high.

## 2. Envelope depth is correct — route to api-contract-check

axios wraps the body in `response.data`, and the backend wraps its payload in
`{ data }`. So a single object is **`res.data.data`**; a nestjs-paginate list is
**`res.data.data.data`** (array) + `res.data.data.meta` (pagination). Getting the
depth wrong yields `undefined` rendered as blank.

- Look for: new/changed `axiosClient.get/post/...` calls and how the result is
  unwrapped; a `.data.data` vs `.data.data.data` choice on a list vs object.
- Action: this is a wire-shape concern — fold it into the `api-contract-check`
  handoff (that skill detects envelope + pagination shape). Note the touched
  call site; don't re-derive the shape here.
- Severity: wrong depth → high (blank/undefined data shown to the user).

## 3. Endpoints registered in the maps and consumed through them — high

`src/api/const.ts` exports two plain-object maps: **`QueryKey`** (React Query key
strings) and **`Endpoint`** (REST paths, some templated). New endpoints must be
added there and used **through** them.

- Look for: a hardcoded path string (`"/assignments"`, a templated URL) or a
  hardcoded query-key string at a call site instead of `Endpoint.Xxx` /
  `QueryKey.Xxx`; a new endpoint used but never added to the maps.
- Severity: hardcoded path/key that bypasses the maps → high (breaks cache
  invalidation and central path management); missing map entry → high.

## 4. Mutations invalidate the correct QueryKey(s) — high

A `useMutation` must `invalidateQueries({ queryKey: [QueryKey.Xxx, …] })` on
success — list **and** detail where relevant — or the cache goes stale and the UI
shows pre-mutation data.

- Look for: a new/changed `useMutation` with no `onSuccess` invalidation, or one
  that invalidates the wrong/only-partial key set (e.g. invalidates the list but
  not the detail it just edited).
- Severity: missing/incorrect invalidation → high (stale data shown after a
  write).

## 5. New mutations use handleMutationError — medium

Mutations use `onError: handleMutationError` for a uniform Mantine error toast
derived from `ApiError`. A new mutation without it fails silently or
inconsistently.

- Look for: a new `useMutation` with no `onError`, or a bespoke error handler
  instead of `handleMutationError`.
- Severity: missing → medium (inconsistent/absent error feedback, no data
  corruption).

## 6. Queries are gated on their dependencies — high

A `useQuery` must set `enabled: !!selectedCourse?.id` (or the relevant guard) so
no request fires with an `undefined` filter — an ungated query hits the backend
with a missing param and returns wrong or empty data.

- Look for: a new `useQuery` whose `queryFn` reads a filter/id that can be
  `undefined`, with no matching `enabled:` guard.
- Severity: ungated query firing with an undefined dependency → high.

## 7. Mantine v7 patterns and theme.ts colors — medium

Styling is **Mantine v7** (not Tailwind, not shadcn) + PostCSS + a few CSS
modules. Colors come from **`src/theme.ts`** (named scales `DarkPurple`,
`Purple`, `AccentGreen`, the `AgentPurple` AI accent, helpers like
`getGradeColor()`), accessed via its exported constants — **not ad-hoc hex**.

- Look for: an introduced Tailwind class, shadcn import, or ad-hoc hex/`rgb()`
  color literal in a component; a Mantine API used in its v6/v8 form (note
  `@mantine/carousel` is on **v8** while the rest is **v7** — mind that seam).
- Severity: new styling system (Tailwind/shadcn) introduced → high (architectural
  drift); ad-hoc hex instead of `theme.ts` → medium.

## 8. Hygiene — medium/blocker

- **No leftover `console.log`** / debug statements — medium.
- **No committed secrets or `.env`** — any added secret is a **blocker** (never
  print its value). The repo already has a git-tracked `.env` problem; don't add
  another.
