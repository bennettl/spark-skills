#!/usr/bin/env node
// CLI over the CDP driver. Run with Node 22:
//   PATH=/opt/homebrew/opt/node@22/bin:$PATH node drive.mjs <command>
//
//   login  [--who EMAIL] [--headed]        real form login; caches the session
//   import --from tokens.json              adopt a session from your own browser (SSO accounts)
//   shot   <url> <out.png> [--who EMAIL]   authenticated full-page screenshot
//   text   <url> [--who EMAIL]             report content-free rendered-text metrics
//   run    <recipe.mjs> [--url PATH]       run a recipe against an authed browser
//   check  [--who EMAIL]                   is the cached session still valid?
import { pathToFileURL } from "node:url";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
} from "node:fs";
import {
  authedBrowser,
  DRIVER_CONFIG_DIR,
  getCredentials,
  importSession,
  loginThroughUI,
  readSession,
  writeSession,
  tokenIsValid,
  WEB_ORIGIN,
} from "./auth.mjs";
import { launch } from "./cdp.mjs";

const argv = process.argv.slice(2);
const cmd = argv[0];
const valueFlags = new Set(["who", "url", "from"]);
const booleanFlags = new Set(["headed", "shred"]);
const flags = new Map();
const positional = [];
let parseError = null;
for (let i = 1; i < argv.length; i++) {
  const arg = argv[i];
  if (!arg.startsWith("--")) {
    positional.push(arg);
    continue;
  }
  const name = arg.slice(2);
  if (name === "port") {
    parseError = "--port is no longer supported; browser ownership requires an ephemeral port";
    break;
  }
  if (booleanFlags.has(name)) {
    flags.set(name, true);
    continue;
  }
  if (!valueFlags.has(name)) {
    parseError = `Unknown flag: --${name}`;
    break;
  }
  const value = argv[++i];
  if (!value || value.startsWith("--")) {
    parseError = `Flag --${name} requires a value`;
    break;
  }
  flags.set(name, value);
}
const flag = (name, fallback = undefined) => flags.get(name) ?? fallback;
const has = (name) => flags.has(name);

// No --port option. Chrome launches on an ephemeral port and the real one is
// read back from DevToolsActivePort in our own profile dir, which is what proves
// the browser we drive is the one we spawned. A fixed port cannot prove that.
//
// Reject the flag rather than ignoring it: someone passing --port believes they
// are controlling which browser gets driven, and silently doing something else
// is the same class of failure this change exists to remove.
const opts = { headless: !has("headed") };

const reportEvents = (b) => {
  const bad = b.drain().filter((e) => e.kind !== "console" || /error/i.test(e.level));
  if (bad.length) {
    const summary = {
      consoleErrors: bad.filter((e) => e.kind === "console").length,
      pageErrors: bad.filter((e) => e.kind === "pageerror").length,
      httpFailuresByStatus: {},
    };
    for (const e of bad.filter((event) => event.kind === "http"))
      summary.httpFailuresByStatus[e.status] =
        (summary.httpFailuresByStatus[e.status] ?? 0) + 1;
    console.log("Page diagnostics (content redacted):", JSON.stringify(summary));
  }
};

const trustedRecipePath = (input) => {
  const root = join(DRIVER_CONFIG_DIR, "recipes");
  const rootStat = lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory() || (rootStat.mode & 0o077) !== 0)
    throw new Error("Trusted recipe directory must be a real, private (0700) directory");
  if (typeof process.getuid === "function" && rootStat.uid !== process.getuid())
    throw new Error("Trusted recipe directory is owned by another user");
  const candidate = resolve(input);
  const candidateStat = lstatSync(candidate);
  if (
    candidateStat.isSymbolicLink() ||
    !candidateStat.isFile() ||
    (candidateStat.mode & 0o077) !== 0
  )
    throw new Error("Recipe must be a real, private (0600) file");
  if (typeof process.getuid === "function" && candidateStat.uid !== process.getuid())
    throw new Error("Recipe is owned by another user");
  const rootReal = realpathSync(root);
  const candidateReal = realpathSync(candidate);
  const within = relative(rootReal, candidateReal);
  if (!within || within.startsWith("..") || isAbsolute(within) || !candidateReal.endsWith(".mjs"))
    throw new Error("Recipe must be an .mjs file inside the trusted reviewer recipe directory");
  return candidateReal;
};

const readPrivateTokenFile = (path) => {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    // Node's own open error (e.g. ELOOP for a symlink) embeds the resolved
    // path; never let that reach stdout/a transcript.
    throw new Error("Token import path could not be opened (symlink or inaccessible)");
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error("Token import path is not a regular file");
    if (typeof process.getuid === "function" && st.uid !== process.getuid())
      throw new Error("Token import file is owned by another user");
    if ((st.mode & 0o077) !== 0)
      throw new Error("Token import file must have mode 0600 or stricter");
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
};

try {
  if (parseError) throw new Error(parseError);
  switch (cmd) {
    case "login": {
      const creds = getCredentials(flag("who"));
      const b = await launch(opts);
      try {
        const tokens = await loginThroughUI(b, creds);
        writeSession(creds.email, tokens);
        console.log("Login verified; session cached securely (mode 600)");
      } finally {
        await b.close();
      }
      break;
    }
    case "import": {
      // Adopt a session captured from a browser the user already signed into.
      // The only path for Google-SSO accounts, which have no Cognito password.
      // Tokens come from a file or env so they never land in a transcript.
      const from = flag("from");
      let tokens;
      const fromPath = from ? resolve(from) : null;
      let shredAfterRead = false;
      try {
        if (fromPath) {
          const raw = readPrivateTokenFile(fromPath);
          shredAfterRead = has("shred");
          try {
            tokens = JSON.parse(raw);
          } catch {
            // JSON.parse's SyntaxError embeds an excerpt of the raw input —
            // e.g. a pasted JWT — verbatim in its message. Never let that
            // reach the outer catch's console.error(err.message).
            throw new Error("Token import file is not valid JSON");
          }
          if (tokens.state) tokens = tokens.state; // accept a raw auth-store blob
        } else if (process.env.SUPACLASS_ACCESS_TOKEN) {
          tokens = {
            accessToken: process.env.SUPACLASS_ACCESS_TOKEN,
            refreshToken: process.env.SUPACLASS_REFRESH_TOKEN,
          };
        } else {
          throw new Error(
            "usage: import --from tokens.json   (or set SUPACLASS_ACCESS_TOKEN / SUPACLASS_REFRESH_TOKEN)\n" +
              'tokens.json: {"accessToken":"…","refreshToken":"…"} — paste the whole auth-store value and it works too'
          );
        }
        const info = await importSession({ ...tokens, who: flag("who") });
        console.log("Imported session verified and cached securely (mode 600)");
        console.log(
          info.refreshToken
            ? "Refresh token present — this session will renew itself for the whole Cognito refresh window."
            : "WARNING: no refreshToken. The access token expires in ~1h and you will have to re-import."
        );
      } finally {
        if (shredAfterRead) {
          unlinkSync(fromPath);
          console.log("Deleted imported token file");
        }
      }
      break;
    }
    case "check": {
      const creds = getCredentials(flag("who"));
      const s = readSession(creds.email);
      if (!s) {
        console.log("No cached session for the selected account");
      } else {
        const ok = await tokenIsValid(s.accessToken, creds.email);
        console.log(
          `Selected account: cached session access token ${ok ? "VALID" : "stale (will refresh or re-login)"}`
        );
      }
      break;
    }
    case "shot": {
      const [url, out] = positional;
      if (!url || !out) throw new Error("usage: shot <url> <out.png>");
      const b = await authedBrowser({ who: flag("who"), url, ...opts });
      try {
        await b.screenshot(resolve(out));
        console.log(`Authenticated session established via ${b.how}`);
        console.log("Private screenshot written (mode 600)");
        reportEvents(b);
      } finally {
        await b.close();
      }
      break;
    }
    case "text": {
      const [url] = positional;
      const b = await authedBrowser({ who: flag("who"), url: url ?? "/", ...opts });
      try {
        const rendered = await b.text();
        console.log(
          `Rendered text: ${rendered.length} characters across ${rendered.split(/\r?\n/).length} lines ` +
            "(content redacted; use a narrowly scoped recipe assertion instead of printing customer data)"
        );
        reportEvents(b);
      } finally {
        await b.close();
      }
      break;
    }
    case "run": {
      const [recipe] = positional;
      if (!recipe) throw new Error("usage: run <recipe.mjs>");
      const trustedRecipe = trustedRecipePath(recipe);
      const b = await authedBrowser({ who: flag("who"), url: flag("url", "/"), ...opts });
      try {
        const mod = await import(pathToFileURL(trustedRecipe).href);
        await (mod.default ?? mod.run)(b);
        reportEvents(b);
      } finally {
        await b.close();
      }
      break;
    }
    case undefined:
    case "help":
      console.log(
        `commands: login | import --from tokens.json | check | shot <url> <out.png> | text <url> | run <recipe.mjs>\n` +
          `origin: ${WEB_ORIGIN}`
      );
      break;
    default:
      throw new Error(`Unknown command: ${cmd}. Run without a command for usage.`);
  }
  process.exitCode = 0;
} catch (err) {
  console.error("FAILED:", err.message);
  process.exitCode = 1;
}
