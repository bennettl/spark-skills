#!/usr/bin/env node
// CLI over the CDP driver. Run with Node 22:
//   PATH=/opt/homebrew/opt/node@22/bin:$PATH node drive.mjs <command>
//
//   login  [--who EMAIL] [--headed]        real form login; caches the session
//   import --from tokens.json              adopt a session from your own browser (SSO accounts)
//   shot   <url> <out.png> [--who EMAIL]   authenticated full-page screenshot
//   text   <url> [--who EMAIL]             dump rendered text + console/HTTP errors
//   run    <recipe.mjs> [--url PATH]       run a recipe against an authed browser
//   check  [--who EMAIL]                   is the cached session still valid?
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { readFileSync, unlinkSync } from "node:fs";
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

// Flags that consume the NEXT argv entry. Everything else is a boolean, and
// the arg after it is a positional. Filtering on "the previous entry started
// with --" instead treated the arg after a boolean flag as that flag's value:
// `text --headed /assignments` yielded NO positionals, so url fell back to "/"
// and the driver silently reported the wrong page — the exact failure this
// tool exists to prevent.
const VALUE_FLAGS = new Set(["who", "from", "url", "port"]);
const positional = (() => {
  const rest = argv.slice(1);
  const out = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith("--")) {
      out.push(a);
      continue;
    }
    if (VALUE_FLAGS.has(a.slice(2))) i++; // skip the value it consumes
  }
  return out;
})();

const opts = { headless: !has("headed"), port: Number(flag("port", 9222)) };

const reportEvents = (b) => {
  const bad = b.drain().filter((e) => e.kind !== "console" || /error/i.test(e.level));
  if (bad.length) {
    console.log("\n--- page errors / failed requests ---");
    for (const e of bad) console.log(JSON.stringify(e));
  }
};

try {
  switch (cmd) {
    case "login": {
      const creds = getCredentials(flag("who"));
      const b = await launch(opts);
      const tokens = await loginThroughUI(b, creds);
      const path = writeSession(creds.email, tokens);
      console.log(`Logged in as ${creds.email}`);
      console.log(`Landed on ${await b.url()}`);
      console.log(`Session cached at ${path} (mode 600)`);
      await b.close();
      break;
    }
    case "import": {
      // Adopt a session captured from a browser the user already signed into.
      // The only path for Google-SSO accounts, which have no Cognito password.
      // Tokens come from a file or env so they never land in a transcript.
      const from = flag("from");
      let tokens;
      if (from) {
        tokens = JSON.parse(readFileSync(resolve(from), "utf8"));
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
      if (from && has("shred")) {
        unlinkSync(resolve(from));
        console.log(`Deleted ${resolve(from)}`);
      }
      break;
    }
    case "check": {
      const creds = getCredentials(flag("who"));
      const s = readSession(creds.email);
      if (!s) {
        console.log(`No cached session for ${creds.email}`);
      } else {
        const ok = await tokenIsValid(s.accessToken);
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
      await b.screenshot(resolve(out));
      console.log(`authenticated as ${b.account.email} via ${b.how}`);
      console.log(`URL: ${await b.url()}`);
      console.log(`Wrote ${resolve(out)}`);
      reportEvents(b);
      await b.close();
      break;
    }
    case "text": {
      const [url] = positional;
      const b = await authedBrowser({ who: flag("who"), url: url ?? "/", ...opts });
      console.log(`URL: ${await b.url()}\n`);
      console.log(await b.text());
      reportEvents(b);
      await b.close();
      break;
    }
    case "run": {
      const [recipe] = positional;
      if (!recipe) throw new Error("usage: run <recipe.mjs>");
      const b = await authedBrowser({ who: flag("who"), url: flag("url", "/"), ...opts });
      const mod = await import(pathToFileURL(resolve(recipe)).href);
      await (mod.default ?? mod.run)(b);
      reportEvents(b);
      await b.close();
      break;
    }
    default:
      console.log(
        `commands: login | import --from tokens.json | check | shot <url> <out.png> | text <url> | run <recipe.mjs>\n` +
          `origin: ${WEB_ORIGIN}`
      );
  }
  process.exit(0);
} catch (err) {
  console.error("FAILED:", err.message);
  process.exit(1);
}
