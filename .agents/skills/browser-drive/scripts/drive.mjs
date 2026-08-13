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
import { resolve } from "node:path";
import { closeSync, constants, fstatSync, openSync, readFileSync, unlinkSync } from "node:fs";
import {
  authedBrowser,
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
const flag = (name, fallback = undefined) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const has = (name) => argv.includes(`--${name}`);
const positional = argv.slice(1).filter((a, i, arr) => !a.startsWith("--") && !String(arr[i - 1] ?? "").startsWith("--"));

// No --port option. Chrome launches on an ephemeral port and the real one is
// read back from DevToolsActivePort in our own profile dir, which is what proves
// the browser we drive is the one we spawned. A fixed port cannot prove that.
//
// Reject the flag rather than ignoring it: someone passing --port believes they
// are controlling which browser gets driven, and silently doing something else
// is the same class of failure this change exists to remove.
if (has("port")) {
  console.error(
    "--port is no longer supported. browser-drive spawns its own Chrome on an\n" +
      "ephemeral port and reads the real one back from DevToolsActivePort, which is\n" +
      "what guarantees it drives the browser it launched rather than yours."
  );
  process.exit(2);
}

const opts = { headless: !has("headed") };

const reportEvents = (b) => {
  const bad = b.drain().filter((e) => e.kind !== "console" || /error/i.test(e.level));
  if (bad.length) {
    console.log("\n--- page errors / failed requests ---");
    for (const e of bad) console.log(JSON.stringify(e));
  }
};

const readPrivateTokenFile = (path) => {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error(`Token import path is not a regular file: ${path}`);
    if (typeof process.getuid === "function" && st.uid !== process.getuid())
      throw new Error(`Token import file is owned by another user: ${path}`);
    if ((st.mode & 0o077) !== 0)
      throw new Error(`Token import file must have mode 0600 or stricter: ${path}`);
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
};

try {
  switch (cmd) {
    case "login": {
      const creds = getCredentials(flag("who"));
      const b = await launch(opts);
      try {
        const tokens = await loginThroughUI(b, creds);
        const path = writeSession(creds.email, tokens);
        console.log(`Logged in as ${creds.email}`);
        console.log(`Landed on ${await b.url()}`);
        console.log(`Session cached at ${path} (mode 600)`);
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
          tokens = JSON.parse(raw);
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
        const who = [info.name, info.type].filter(Boolean).join(", ");
        console.log(`Imported session for ${info.email}${who ? ` (${who})` : ""}`);
        console.log(`Cached at ${info.path} (mode 600)`);
        console.log(
          info.refreshToken
            ? "Refresh token present — this session will renew itself for the whole Cognito refresh window."
            : "WARNING: no refreshToken. The access token expires in ~1h and you will have to re-import."
        );
      } finally {
        if (shredAfterRead) {
          unlinkSync(fromPath);
          console.log(`Deleted ${fromPath}`);
        }
      }
      break;
    }
    case "check": {
      const creds = getCredentials(flag("who"));
      const s = readSession(creds.email);
      if (!s) {
        console.log(`No cached session for ${creds.email}`);
      } else {
        const ok = await tokenIsValid(s.accessToken, creds.email);
        console.log(
          `${creds.email}: cached ${s.savedAt} — access token ${ok ? "VALID" : "stale (will refresh or re-login)"}`
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
        console.log(`authenticated as ${b.account.email} via ${b.how}`);
        console.log(`URL: ${await b.url()}`);
        console.log(`Wrote ${resolve(out)}`);
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
        console.log(`URL: ${await b.url()}\n`);
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
      const b = await authedBrowser({ who: flag("who"), url: flag("url", "/"), ...opts });
      try {
        const mod = await import(pathToFileURL(resolve(recipe)).href);
        await (mod.default ?? mod.run)(b);
        reportEvents(b);
      } finally {
        await b.close();
      }
      break;
    }
    default:
      console.log(
        `commands: login | import --from tokens.json | check | shot <url> <out.png> | text <url> | run <recipe.mjs>\n` +
          `origin: ${WEB_ORIGIN}`
      );
  }
  process.exitCode = 0;
} catch (err) {
  console.error("FAILED:", err.message);
  process.exitCode = 1;
}
