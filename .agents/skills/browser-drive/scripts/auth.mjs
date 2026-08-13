// Authenticated-session handling for the CDP driver.
//
// Two paths, in order of preference:
//   1. seed  — reuse tokens cached from a previous real login (fast, ~2s)
//   2. login — drive the real /login form with email + password (slow, ~8s)
//
// We never mint a token. The cache only ever holds tokens the app itself
// issued in response to a real credential submission.
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { launch } from "./cdp.mjs";

const trustedLocalOrigin = (label, value) => {
  const url = new URL(value);
  const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !loopback.has(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error(`${label} must be a root HTTP(S) loopback origin; refusing to expose credentials to ${value}`);
  return url.origin;
};

export const WEB_ORIGIN = trustedLocalOrigin(
  "SUPACLASS_WEB_ORIGIN",
  process.env.SUPACLASS_WEB_ORIGIN ?? "http://localhost:5173"
);
export const API_ORIGIN = trustedLocalOrigin(
  "SUPACLASS_API_ORIGIN",
  process.env.SUPACLASS_API_ORIGIN ?? "http://localhost:3002"
);

export const DRIVER_CONFIG_DIR =
  process.env.SUPACLASS_DRIVER_CONFIG_DIR ?? join(homedir(), ".config", "supaclass-driver");

const normalizeEmail = (s) => s.trim().toLowerCase();
const authRequestSignal = () => AbortSignal.timeout(10000);
const sessionKey = (email) =>
  createHash("sha256").update(normalizeEmail(email), "utf8").digest("hex");

const readPrivateConfig = (path) => {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error(`Sensitive config is not a regular file: ${path}`);
    if (typeof process.getuid === "function" && st.uid !== process.getuid())
      throw new Error(`Sensitive config is owned by another user: ${path}`);
    if ((st.mode & 0o077) !== 0)
      throw new Error(`Sensitive config must have mode 0600 or stricter: ${path}`);
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
};

/**
 * Credentials come from the environment or a file OUTSIDE the repo, so a
 * password never lands in git or in a transcript.
 *   env:  SUPACLASS_EMAIL / SUPACLASS_PASSWORD
 *   file: ~/.config/supaclass-driver/creds.json
 *         { "default": "a@b.com",
 *           "accounts": { "a@b.com": { "password": "...", "role": "student" } } }
 */
export function getCredentials(who) {
  if (process.env.SUPACLASS_EMAIL && process.env.SUPACLASS_PASSWORD && !who) {
    return { email: process.env.SUPACLASS_EMAIL, password: process.env.SUPACLASS_PASSWORD };
  }
  const path = join(DRIVER_CONFIG_DIR, "creds.json");
  if (!existsSync(path)) {
    throw new Error(
      `No credentials. Either export SUPACLASS_EMAIL and SUPACLASS_PASSWORD, or create ${path}:\n` +
        `  {"default":"you@example.com","accounts":{"you@example.com":{"password":"...","role":"student"}}}`
    );
  }
  const cfg = JSON.parse(readPrivateConfig(path));
  const email = who ?? cfg.default ?? Object.keys(cfg.accounts ?? {})[0];
  const acct = cfg.accounts?.[email];
  // A missing password is NOT fatal. Google-SSO accounts have no Cognito
  // password at all (USER_PASSWORD_AUTH returns "User is not authorized to get
  // auth details"), and reach a session via `drive.mjs import` instead. Only a
  // form login actually needs a password, so that is where we complain.
  return { email, password: acct?.password, role: acct?.role, ssoOnly: acct?.ssoOnly === true };
}

/** Store tokens captured from a real browser session (SSO accounts). */
export async function importSession({ accessToken, refreshToken, who }) {
  if (!accessToken) throw new Error("importSession needs an accessToken");
  const r = await fetch(`${API_ORIGIN}/users/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: authRequestSignal(),
  });
  if (r.status !== 200)
    throw new Error(
      `That access token is not valid (/users/me returned ${r.status}). ` +
        `Copy a fresh one — access tokens expire in about an hour.`
    );
  const body = await r.json();
  const me = body?.data ?? body;
  const email = me?.email ?? who;
  if (!email) throw new Error("Could not determine the account email from /users/me");
  if (who && me?.email && normalizeEmail(who) !== normalizeEmail(me.email))
    throw new Error(`Token belongs to ${me.email}, not ${who}`);
  const path = writeSession(email, { accessToken, refreshToken: refreshToken ?? null });
  return { email, path, name: [me?.firstName, me?.lastName].filter(Boolean).join(" "), type: me?.type, refreshToken };
}

const sessionPath = (email) => join(DRIVER_CONFIG_DIR, `session-${sessionKey(email)}.json`);

export function readSession(email) {
  const p = sessionPath(email);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readPrivateConfig(p));
  } catch {
    return null;
  }
}

export function writeSession(email, tokens) {
  mkdirSync(DRIVER_CONFIG_DIR, { recursive: true, mode: 0o700 });
  const configStat = lstatSync(DRIVER_CONFIG_DIR);
  if (configStat.isSymbolicLink() || !configStat.isDirectory())
    throw new Error("Refusing to store a session in a non-directory or symlinked config path");
  if (typeof process.getuid === "function" && configStat.uid !== process.getuid())
    throw new Error("Refusing to store a session in a config directory owned by another user");
  chmodSync(DRIVER_CONFIG_DIR, 0o700);
  const p = sessionPath(email);
  const tmp = join(DRIVER_CONFIG_DIR, `.session-${randomUUID()}.tmp`);
  let fd;
  try {
    fd = openSync(
      tmp,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      0o600
    );
    writeFileSync(
      fd,
      JSON.stringify({ email, ...tokens, savedAt: new Date().toISOString() }, null, 2)
    );
    closeSync(fd);
    fd = undefined;
    chmodSync(tmp, 0o600);
    // Atomic replacement changes the directory entry itself; an existing
    // session-path symlink is replaced, never followed to its target.
    renameSync(tmp, p);
    chmodSync(p, 0o600);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(tmp)) unlinkSync(tmp);
  }
  return p;
}

/** Cheap server-side check that an access token is still good. */
export async function tokenIsValid(accessToken, expectedEmail) {
  if (!accessToken) return false;
  try {
    const r = await fetch(`${API_ORIGIN}/users/me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: authRequestSignal(),
    });
    if (r.status !== 200) return false;
    if (!expectedEmail) return true;
    const body = await r.json();
    const observedEmail = (body?.data ?? body)?.email;
    return Boolean(observedEmail) && normalizeEmail(observedEmail) === normalizeEmail(expectedEmail);
  } catch {
    return false;
  }
}

/**
 * Log in by driving the real form: type into the Mantine inputs, click the
 * real Sign In button, wait to leave /login. Returns the tokens the app stored.
 *
 * Selectors are attribute-based on purpose — Mantine generates a fresh random
 * id ("mantine-hf5ovnlub") on every render, so id selectors are worthless here.
 */
export async function loginThroughUI(b, { email, password }) {
  if (!password)
    throw new Error(
      `No password for ${email}. If this is a Google-SSO account it has none and never will — ` +
        `capture a session instead:\n` +
        `  1. sign in as ${email} in your normal browser\n` +
        `  2. DevTools > Application > Local Storage > auth-store, copy state.accessToken AND state.refreshToken\n` +
        `  3. node drive.mjs import --from /path/to/tokens.json`
    );
  await b.goto(`${WEB_ORIGIN}/login`);
  await b.waitFor('input[placeholder="your@email.com"]');
  await b.type('input[placeholder="your@email.com"]', email);
  await b.type("input[type=password]", password);
  await b.clickText("Sign In");

  // Success = we navigate away from /login. Failure = a Mantine notification
  // appears and we stay put. Watch for either rather than a blind sleep.
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    const url = await b.url();
    if (!url.includes("/login")) break;
    // Must target [role=alert] (the notification itself). A [class*=Notification]
    // selector matches the empty "mantine-Notifications-root" CONTAINER first and
    // silently yields "", which reads as "no error".
    const err = await b.eval(
      `(() => { const n = [...document.querySelectorAll('[role="alert"]')]
                  .map(e => e.innerText.trim()).filter(Boolean);
                return n.length ? n.join(" | ") : null; })()`
    );
    if (err) throw new Error(`Login rejected: ${err.replace(/\s+/g, " ").trim()}`);
    await new Promise((r) => setTimeout(r, 300));
  }
  if ((await b.url()).includes("/login")) throw new Error("Login timed out on /login");

  await b.settle();
  const tokens = await b.eval(`(() => {
    const raw = localStorage.getItem('auth-store');
    if (!raw) return null;
    const s = JSON.parse(raw).state || {};
    return { accessToken: s.accessToken, refreshToken: s.refreshToken };
  })()`);
  if (!tokens?.accessToken) throw new Error("Logged in but no accessToken in auth-store");
  return tokens;
}

/** Read whatever token the store currently holds (the app may have refreshed it). */
async function storeToken(b) {
  return b.eval(`(() => {
    const raw = localStorage.getItem('auth-store');
    if (!raw) return null;
    return (JSON.parse(raw).state || {}).accessToken || null;
  })()`);
}

/**
 * Hand back a browser already sitting on a genuinely authenticated page.
 *
 * IMPORTANT: a stale token does NOT bounce you to /login. AuthenticatedGuard
 * only checks that accessToken is defined, so an expired token renders the
 * full app shell with every query 401ing — it looks like a logged-in page with
 * mysteriously empty data. Screenshotting that state is exactly how a healthy
 * app gets misdiagnosed as broken, so we assert a real /users/me 200 before
 * handing the browser back rather than trusting the URL.
 */
export async function authedBrowser({ who, url = "/", force = false, ...opts } = {}) {
  const creds = getCredentials(who);
  const b = await launch(opts);
  try {
  const target = `${WEB_ORIGIN}${url.startsWith("/") ? url : "/" + url}`;
  const cached = force ? null : readSession(creds.email);
  let how = "form login";

  if (cached?.accessToken) {
    // Seed both tokens and let the app refresh itself. An expired access token
    // paired with a live refresh token self-heals, so one password login keeps
    // working for the whole Cognito refresh window.
    await b.seedAuth(WEB_ORIGIN, cached);
    await b.goto(target);
    const current = await storeToken(b);
    if (await tokenIsValid(current, creds.email)) {
      how = current === cached.accessToken ? "cached session" : "cached session (auto-refreshed)";
      if (current !== cached.accessToken)
        writeSession(creds.email, {
          accessToken: current,
          refreshToken: (await b.eval(
            `(JSON.parse(localStorage.getItem('auth-store')).state||{}).refreshToken || null`
          )) ?? cached.refreshToken,
        });
    } else {
      // Clear the dud token so the guard sends us to a clean /login form.
      await b.eval(`localStorage.removeItem('auth-store')`);
      const tokens = await loginThroughUI(b, creds);
      writeSession(creds.email, tokens);
      await b.goto(target);
    }
  } else {
    const tokens = await loginThroughUI(b, creds);
    writeSession(creds.email, tokens);
    await b.goto(target);
  }

  const finalToken = await storeToken(b);
  if (!(await tokenIsValid(finalToken, creds.email)))
    throw new Error("Ended up without a valid session — refusing to hand back a half-authenticated page");
  if ((await b.url()).includes("/login"))
    throw new Error(`Redirected to /login while requesting ${url} — account may lack access to that route`);

  b.account = creds;
  b.how = how;
  return b;
  } catch (err) {
    await b.close().catch(() => {});
    throw err;
  }
}
