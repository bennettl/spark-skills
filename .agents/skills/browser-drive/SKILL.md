---
name: browser-drive
description: Drive the running Supaclass web app in a real browser — log in, click, type, submit, and screenshot — to verify UI behavior first-hand instead of asking the user to look. Use whenever a change needs confirming in the real app, a screenshot of an authenticated page is needed, or a bug report describes what a page looks like after an action (submitting, saving, grading). Handles authenticated sessions; do not hand-roll headless Chrome for this repo.
---

# Driving the Supaclass web app

Verify UI claims by operating the app, not by reading components and inferring.
Two bad calls came from inferring: one described a form's pre-submit state and
missed what renders after submitting; one diagnosed unrealistic seed data as a
P0 bug. Both are things a driver catches in one run.

## Prerequisites

- **Node 22** — `export PATH=/opt/homebrew/opt/node@22/bin:$PATH   # homebrew macOS; any Node 22 works`
- Vite on **:5173**, API on **:3002**, both already running. Do not start,
  restart, or kill either; another session may be using them.
- Credentials at `~/.config/supaclass-driver/creds.json` (mode 600, outside the
  repo, never committed):

  ```json
  {
    "default": "<student-account>",
    "accounts": {
      "<student-account>": { "password": "…", "role": "student" },
      "<staff-account>":   { "role": "instructor", "ssoOnly": true }
    }
  }
  ```

  Read the configured account names out of that file rather than expecting them
  here — they differ per developer, and this registry is shared. `node drive.mjs
  check` prints who is configured without revealing a password.

  Ask the user for a password. Never invent one, and never hand-craft a JWT —
  `LTI_JWT_SECRET` is the LTI path, not the app session.

  **A Google-SSO account has no password and never will.** `POST /users/login`
  returns `400 User is not authorized to get auth details` — Cognito refusing
  `USER_PASSWORD_AUTH` for a federated user. Forgot Password cannot fix it;
  there is nothing to reset. Mark such an account `"ssoOnly": true` and use
  `import` (below). Do not try to automate the Google consent screen. Expect to
  need both paths: on this project the student test account has a password and
  the staff account is SSO-only.

## Commands

Run from `.claude/skills/browser-drive/scripts`:

```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH   # homebrew macOS; any Node 22 works

node drive.mjs login                              # real form login; caches the session
node drive.mjs import --from tokens.json          # adopt a browser session (SSO accounts)
node drive.mjs check                              # is the cached session still good?
node drive.mjs shot /assignments out.png          # authenticated full-page screenshot
node drive.mjs text /assignments                  # rendered text + console/HTTP errors
node drive.mjs run recipe.mjs --url /assignments  # multi-step interaction
node drive.mjs shot / out.png --who <staff-account>  # pick a non-default account
node drive.mjs shot / out.png --headed            # watch it happen
```

Then `Read` the PNG — the screenshots are legible at 1400px wide.

## How auth works

`POST /users/login` (email + password) returns Cognito tokens, which the app
persists to `localStorage` under `auth-store` → `state.accessToken`.

First run logs in through the **real form**. Both tokens are cached to
`~/.config/supaclass-driver/session-<email>.json`, so later runs seed
`localStorage` and skip the form (~2s instead of ~8s). When the access token
expires the app refreshes it from the refresh token by itself, so **one password
login keeps working for the whole Cognito refresh window**; the fresh token is
written back to the cache. A form login only happens again when that fails.

Seeding a token the app itself issued is fine. Minting one is not.

### SSO-only accounts: `import`

An account with no Cognito password can never use the form. Adopt a session the
user already has instead — this is the same token the `pi-smoke` harness asks
for, just captured once rather than every run:

1. Sign into the app as that account in a normal browser.
2. DevTools → Application → Local Storage → `auth-store`. Copy **both**
   `state.accessToken` and `state.refreshToken`.
3. Put them in a file and import it:

```bash
cat > /tmp/tokens.json <<'EOF'
{"accessToken":"eyJ…","refreshToken":"eyJ…"}
EOF
node drive.mjs import --from /tmp/tokens.json --shred
```

`--shred` deletes the file afterwards. Pasting the entire `auth-store` value
works too — the `{"state":{…}}` wrapper is unwrapped automatically. The import
is verified against `/users/me` before caching, so a stale token is rejected
immediately with a clear message instead of failing later as an empty page.

**Copy the refresh token, not just the access token.** With it the session
renews itself for the whole Cognito refresh window; without it you re-import
every hour.

## Writing a recipe

A recipe exports a function taking an already-authenticated browser:

```js
// recipe.mjs
export default async function (b) {
  await b.clickText("ZZ Edge Cases");
  await b.waitForText("Question 1");
  await b.type("textarea", "Driver test answer");
  await b.screenshot("/tmp/before-submit.png");

  await b.clickText("Submit");
  await b.waitForText("Submitted");            // verify AFTER the action
  await b.screenshot("/tmp/after-submit.png"); // this is the state that matters
  console.log(await b.text());
}
```

API: `goto` `click` `clickText` `setFiles` `type` `waitFor` `waitForText` `eval`
`text` `url` `screenshot` `settle` `drain`.

Also available, and used by the "bug or fixture?" recipe below: `on(event, fn)`
subscribes to a raw CDP event and returns an unsubscribe function, and
`send(method, params)` issues a raw CDP command — together they let a recipe
read response bodies (`Network.getResponseBody`) rather than guess from the DOM.

**Submitting a form inside a modal** — the shape every upload/attach flow in this
app needs:

```js
await b.clickText("Upload Submission");                   // opens the modal
await b.waitForText("Upload file");
await b.setFiles('input[type="file"]', "/tmp/essay.pdf");  // hidden behind the dropzone
await b.type('input[placeholder*="chatgpt.com/share"]', link);
await b.clickText("Upload", { exact: true, within: "[role=dialog]" });
```

`exact` and `within` are both load-bearing here: "Upload" substring-matches the
page's "Upload Submission" header button, which sits earlier in the DOM. There is
also a `dom: true` option that uses `el.click()` instead of a coordinate click —
rarely needed, and not needed for modals.

## Traps this setup already handles — and the ones you must respect

**A stale token does not redirect you to `/login`.** `AuthenticatedGuard` only
checks that `accessToken` is defined, so an expired token renders the complete
app shell with every query 401ing — a logged-in-looking page with mysteriously
empty data. This is the single most dangerous state to screenshot, because it
looks exactly like a data bug. `authedBrowser` asserts a real `/users/me` 200
before handing the browser back and throws rather than return a half-auth page.
If you bypass it, check `drain()` for 401s before believing an empty page.

**Empty data is usually the fixture, not a bug.** The `~/pi-smoke` seed is
grading-blind: rows seeded `done` have no score and no questions. Grades and
Insights screenshots there look severely broken and are not. Confirm against
the fixture before reporting a P0.

Worked example — `/insights` renders a header and **nothing else** in Smoke Test
Course. Before calling that a bug, the driver showed every API call returning
200 and *no insights endpoint being requested at all*. Cause: `/topics` returns
`totalItems: 0`, so `InsightsPage` renders neither the content (gated on
`topics.length > 0`) nor the empty state (gated on
`educationLevel === Secondary`, while this org is `null`). A zero-topic course
in a non-Secondary org is simply a blank page. Recipe at the bottom of this
file reproduces the check.

**Route access is by course-member role, not user type.** The sidebar badge
shows the global type (`CSR`, `STUDENT`), but `InstructorGuard` only rejects
`CourseMemberRole.student`. A `csr` user reaches every instructor route, so
don't read the badge and conclude a route should have been blocked.

**`clickText` used to click the wrong element after the first call.** It marks its
target with a constant `data-cdp` attribute and then re-queries by it. Because the
marker was never cleared, a leftover from an earlier `clickText` matched first in
document order — so `clickText("Upload Submission")` followed by
`clickText("Upload", { within: "[role=dialog]" })` clicked the *header* button
again, toggling the modal instead of submitting. No error, no request, the modal
gone: it read as an application bug for two full runs. Fixed by clearing stale
markers before tagging. If you add another marker-based helper, clear first.

**`clickText` substring-matches and takes the first match in DOM order.**
`"Upload"` finds the page's **"Upload Submission"** header button before the
modal's **"Upload"**, and this app is full of that shape — `"Attach"` vs
`"Attach Conversation"`. Use `{ exact: true }`, and `{ within: "[role=dialog]" }`
to scope. `clickText` now throws if it matches a disabled button rather than
clicking into the void.

**Mantine generates a random id per render** (`mantine-hf5ovnlub`), so id
selectors are worthless. Use attributes (`input[type=password]`,
`input[placeholder="your@email.com"]`) or `clickText`.

**A file input cannot be filled by assignment.** `input.files` is read-only and
React would swallow it anyway. `setFiles()` goes through CDP
`DOM.setFileInputFiles`, which emits the real `change` event Mantine's Dropzone
listens for. The input is usually hidden behind the styled dropzone, so `setFiles`
deliberately does not wait for visibility.

**React ignores `el.value = x`.** It tracks the previous value and swallows the
change. `type()` focuses the field and uses CDP `Input.insertText`, which emits
real input events that `@mantine/form` honors.

**Notification text lives on `[role="alert"]`.** A `[class*="Notification"]`
selector matches the empty `mantine-Notifications-root` container first and
returns `""`, which silently reads as "no error". Notifications auto-dismiss
after ~10s.

**Use `--headless=new`.** The old `--headless` hangs on this machine.

## Rules for this stack

- **Never reseed or mutate the database.** `~/pi-smoke` holds calibrated
  fixtures the smoke harness asserts on. Do not quote its expected values here:
  the harness currently hardcodes `attachRate 0.8`, which assumed a
  fixtures-only DB and is **stale** — with real submissions present the correct
  answer is 0.83, tracked in SUP2-26. Read the expected values from the harness,
  and never bend application code to match them.
- **Never restart the API or kill the Vite dev server.**
- Reading and screenshotting is always safe. If you must submit something, use
  the **ZZ Edge Cases** assignment
  (`aa000000-0000-4000-8000-000000000002`) — never Essay 1
  (`aa000000-0000-4000-8000-000000000001`).
- The `pi-student*@local.test` fixture users **have no Cognito accounts and
  cannot log in.** Use a real test account.

## Why CDP and not Playwright

Node 22 ships global `fetch` and `WebSocket`, and Chrome is already installed,
so speaking CDP directly needs **zero dependencies and no change to
`package.json`**. Playwright would mean a repo dependency plus a ~150MB browser
download; chromedriver would mean a Homebrew install plus a client library.
Neither buys anything here — the app is local, Chrome-only, and every
interaction is a click, a keystroke, or a screenshot.

## Recipe: is this empty page a bug or the fixture?

Answers it with evidence instead of a guess. Adapt the URL.

```js
// why-empty.mjs — node drive.mjs run why-empty.mjs --who <account>
export default async function (b) {
  const calls = [];
  b.on("Network.responseReceived", (p) => {
    if (p.response.url.includes(":3002"))
      calls.push({ id: p.requestId, url: p.response.url, status: p.response.status });
  });
  await b.goto("http://localhost:5173/insights");
  await new Promise((r) => setTimeout(r, 3500));
  await b.settle();

  for (const c of calls) console.log(c.status, c.url.replace("http://localhost:3002", ""));
  for (const c of calls.filter((c) => /insight|analytic|topic/i.test(c.url))) {
    const r = await b.send("Network.getResponseBody", { requestId: c.id });
    console.log(`\n[${c.status}] ${c.url}\n${r.body.slice(0, 600)}`);
  }
  console.log(await b.text());
}
```

Read it in this order:

1. **Any non-200?** Then it is a request failure, not empty data.
2. **Was the relevant endpoint even called?** If the page never asked for its
   data, the cause is upstream — a gate, a disabled query, or a missing
   prerequisite — not the API.
3. **Did it return 200 with an empty collection?** That is the fixture. Check
   `~/pi-smoke` before reporting anything.
