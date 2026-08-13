// Minimal Chrome DevTools Protocol driver. Zero dependencies: Node 22 ships
// global fetch and WebSocket, so this needs nothing added to any repo.
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Overridable so this is not pinned to one machine's layout. First match wins.
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/opt/homebrew/bin/chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean);

const CHROME = CHROME_CANDIDATES.find((p) => existsSync(p));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Browser {
  constructor({ port = 0, headless = true, profileDir = null } = {}) {
    // A fixed debug port cannot be made safe here. launch() always spawns a new
    // Chrome; if that port is already bound, Chrome comes up *portless* while the
    // port keeps answering from the instance that got there first — so we would
    // silently drive someone else's browser, and close() sends Browser.close,
    // which terminates it entirely. Chrome only writes DevToolsActivePort (our
    // one proof of ownership) when the requested port is ephemeral, so there is
    // no fixed-port variant that can verify what it attached to. Verified by
    // execution: port 0 writes the file, port 9333 does not.
    if (port) {
      throw new Error(
        `browser-drive spawns its own Chrome and must use an ephemeral debug port ` +
          `(got port ${port}). A fixed port can attach to a browser we did not ` +
          `launch — including your real one, which close() would shut down.`
      );
    }
    // Resolved from DevToolsActivePort during launch().
    this.port = 0;
    this.headless = headless;
    this.profileDir = profileDir ?? mkdtempSync(join(tmpdir(), "cdp-profile-"));
    this.ownsProfile = profileDir === null;
    this.msgId = 0;
    this.pending = new Map();
    this.events = [];
    this.inflightRequests = new Set();
    this.networkLastActivity = Date.now();
  }

  async launch() {
    const args = [
      // Ephemeral. The real port is read back from DevToolsActivePort below.
      "--remote-debugging-port=0",
      `--user-data-dir=${this.profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--disable-features=Translate,MediaRouter",
      "--window-size=1400,1000",
      "about:blank",
    ];
    // --headless=new; the old --headless hangs on this machine.
    if (this.headless) args.unshift("--headless=new");

    if (!CHROME)
      throw new Error(
        `No Chrome found. Tried:\n  ${CHROME_CANDIDATES.join("\n  ")}\n` +
          `Set CHROME_PATH to your binary.`
      );
    // A stale file from an earlier run in a reused profile would point us at a
    // browser that is not ours.
    const portFile = join(this.profileDir, "DevToolsActivePort");
    rmSync(portFile, { force: true });

    this.proc = spawn(CHROME, args, { stdio: "ignore", detached: false });

    // Learn OUR port from OUR profile directory instead of trusting whoever
    // answers on a well-known one. Chrome writes DevToolsActivePort into the
    // user-data-dir once the endpoint is listening: line 1 is the port, line 2
    // the browser websocket path. Because each Browser gets its own mkdtemp
    // profile, the presence of this file is proof the endpoint belongs to the
    // process we just spawned.
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (this.proc.exitCode !== null)
        throw new Error(
          `Chrome exited (code ${this.proc.exitCode}) before the debug endpoint came up`
        );
      if (existsSync(portFile)) {
        const first = readFileSync(portFile, "utf8").split("\n")[0].trim();
        if (first) {
          this.port = Number(first);
          break;
        }
      }
      await sleep(100);
    }
    if (!this.port)
      throw new Error(
        "Chrome never reported a debug port (no DevToolsActivePort written to the profile)"
      );

    // Endpoint is ours; confirm it actually speaks CDP before driving it.
    let wsUrl = null;
    const vdl = Date.now() + 10000;
    while (Date.now() < vdl) {
      try {
        const r = await fetch(`http://127.0.0.1:${this.port}/json/version`);
        const j = await r.json();
        if (j.webSocketDebuggerUrl) {
          wsUrl = j.webSocketDebuggerUrl;
          break;
        }
      } catch {
        /* not up yet */
      }
      await sleep(150);
    }
    if (!wsUrl) throw new Error("Chrome debugging endpoint never came up");

    // Find the page target (not the browser target) so we can drive the DOM.
    let pageWs = null;
    const pdl = Date.now() + 10000;
    while (Date.now() < pdl) {
      const list = await (
        await fetch(`http://127.0.0.1:${this.port}/json/list`)
      ).json();
      const page = list.find((t) => t.type === "page");
      if (page?.webSocketDebuggerUrl) {
        pageWs = page.webSocketDebuggerUrl;
        break;
      }
      await sleep(150);
    }
    if (!pageWs) throw new Error("no page target found");

    await this._connect(pageWs);
    await this.send("Page.enable");
    await this.send("Runtime.enable");
    await this.send("Network.enable");
    // Needed by setFiles(): DOM.getDocument / DOM.querySelector / setFileInputFiles.
    await this.send("DOM.enable");
    // Surface page console + failed requests; invaluable for diagnosing a
    // screenshot that renders but is silently broken.
    this.on("Runtime.consoleAPICalled", (p) =>
      this.events.push({
        kind: "console",
        level: p.type,
        text: p.args.map((a) => a.value ?? a.description ?? a.type).join(" "),
      })
    );
    this.on("Runtime.exceptionThrown", (p) =>
      this.events.push({
        kind: "pageerror",
        text: p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text,
      })
    );
    this.on("Network.responseReceived", (p) => {
      if (p.response.status >= 400)
        this.events.push({
          kind: "http",
          status: p.response.status,
          url: p.response.url,
        });
    });
    const noteNetworkActivity = () => {
      this.networkLastActivity = Date.now();
    };
    this.on("Network.requestWillBeSent", (p) => {
      this.inflightRequests.add(p.requestId);
      noteNetworkActivity();
    });
    this.on("Network.loadingFinished", (p) => {
      this.inflightRequests.delete(p.requestId);
      noteNetworkActivity();
    });
    this.on("Network.loadingFailed", (p) => {
      this.inflightRequests.delete(p.requestId);
      noteNetworkActivity();
    });
    return this;
  }

  _connect(wsUrl) {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(wsUrl);
      this.handlers = new Map();
      this.ws.onopen = () => resolve();
      this.ws.onerror = (e) => reject(new Error("ws error: " + e.message));
      this.ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve: res, reject: rej } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
        } else if (msg.method) {
          // Copy before dispatch: a handler may unsubscribe itself, and
          // splicing the live array mid-forEach silently skips the next one.
          const h = this.handlers.get(msg.method);
          if (h) [...h].forEach((fn) => fn(msg.params));
        }
      };
    });
  }

  /** Subscribe to a CDP event. Returns an unsubscribe function. */
  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
    return () => this.off(method, fn);
  }

  off(method, fn) {
    const list = this.handlers.get(method);
    if (!list) return;
    const i = list.indexOf(fn);
    if (i !== -1) list.splice(i, 1);
  }

  send(method, params = {}) {
    const id = ++this.msgId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 30000);
    });
  }

  /** Run JS in the page and return its value (awaits promises). */
  async eval(expr) {
    const r = await this.send("Runtime.evaluate", {
      expression: typeof expr === "function" ? `(${expr})()` : expr,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails)
      throw new Error(
        "page eval threw: " +
          (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
      );
    return r.result.value;
  }

  async goto(url, { waitUntil = "load" } = {}) {
    const ev = waitUntil === "load" ? "Page.loadEventFired" : "Page.domContentEventFired";
    let unsubscribe;
    const loaded = new Promise((resolve) => {
      unsubscribe = this.on(ev, () => resolve());
      setTimeout(resolve, 15000);
    });
    try {
      await this.send("Page.navigate", { url });
      await loaded;
    } finally {
      unsubscribe();
    }
    await this.settle();
  }

  /** Wait for the network to go quiet — SPA data loads finish after load. */
  async settle(quietMs = 600, timeout = 12000) {
    // Tracking is browser-lifetime state installed immediately after
    // Network.enable, before any caller navigation. Installing handlers here
    // would miss SPA requests that began while goto() awaited the load event.
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (
        this.inflightRequests.size === 0 &&
        Date.now() - this.networkLastActivity > quietMs
      )
        return;
      await sleep(100);
    }
    throw new Error(`Network did not settle within ${timeout}ms`);
  }

  /** Poll until a CSS selector matches (or a predicate returns truthy). */
  async waitFor(selector, { timeout = 15000, visible = true } = {}) {
    const deadline = Date.now() + timeout;
    // A predicate may arrive as a function OR as source text (waitForText builds
    // the latter so it can inline its argument). Testing only `typeof === string`
    // sent that source to querySelector and threw a SyntaxError.
    const isPredicate =
      typeof selector === "function" ||
      /^\s*(\(|function\b|async\b)/.test(selector);
    const expr = isPredicate
      ? `(${selector})()`
      : `(() => { const el = document.querySelector(${JSON.stringify(selector)});
             if (!el) return false;
             ${visible ? "const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0;" : "return true;"} })()`;
    while (Date.now() < deadline) {
      if (await this.eval(expr)) return true;
      await sleep(150);
    }
    throw new Error(`waitFor timed out: ${selector}`);
  }

  /** Wait for text to appear anywhere in the rendered body. */
  async waitForText(text, { timeout = 15000 } = {}) {
    return this.waitFor(
      `() => document.body && document.body.innerText.includes(${JSON.stringify(text)})`,
      { timeout }
    );
  }

  /**
   * Type into a controlled React input. Setting .value directly does NOT work
   * with Mantine/React — React tracks the previous value and swallows the
   * change. Focusing and using Input.insertText produces real InputEvents that
   * React's onChange honors.
   */
  async type(selector, text, { clear = true } = {}) {
    await this.waitFor(selector);
    await this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      el.focus();
      ${clear ? "el.select && el.select();" : ""}
    })()`);
    if (clear) {
      await this.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "Delete",
        code: "Delete",
        windowsVirtualKeyCode: 46,
      });
      await this.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Delete", code: "Delete" });
    }
    await this.send("Input.insertText", { text });
    await sleep(60);
  }

  /**
   * Attach local files to a file input.
   *
   * `input.files` is read-only, and React would swallow a direct assignment the
   * same way it swallows `el.value = x`. This goes through CDP
   * `DOM.setFileInputFiles`, which sets them as the browser would and emits a
   * real `change` event that Mantine's Dropzone honours.
   *
   * The input is usually hidden behind a styled dropzone, so this deliberately
   * does not wait for visibility.
   */
  async setFiles(selector, paths) {
    const files = (Array.isArray(paths) ? paths : [paths]).map((p) => resolve(p));
    for (const f of files) {
      if (!existsSync(f)) throw new Error(`setFiles: no such file: ${f}`);
    }
    await this.waitFor(selector, { visible: false });
    const { root } = await this.send("DOM.getDocument", {
      depth: -1,
      pierce: true,
    });
    const { nodeId } = await this.send("DOM.querySelector", {
      nodeId: root.nodeId,
      selector,
    });
    if (!nodeId) throw new Error(`setFiles: selector not found: ${selector}`);
    await this.send("DOM.setFileInputFiles", { files, nodeId });
    await sleep(200);
  }

  /** Click via real mouse events at the element's centre. */
  async click(selector, { timeout = 15000 } = {}) {
    await this.waitFor(selector, { timeout });
    const box = await this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      el.scrollIntoView({block:'center'});
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width/2, y: r.top + r.height/2 };
    })()`);
    for (const type of ["mousePressed", "mouseReleased"]) {
      await this.send("Input.dispatchMouseEvent", {
        type,
        x: box.x,
        y: box.y,
        button: "left",
        clickCount: 1,
      });
    }
    await sleep(120);
  }

  /**
   * Click the first element whose text matches. Mantine buttons have no stable ids.
   *
   * Substring matching takes the first match in DOM order, which bites when one
   * label contains another — "Upload" matches the page's "Upload Submission"
   * header button before the modal's "Upload", and clicking behind an open
   * overlay silently does nothing. This app also has "Attach" / "Attach
   * Conversation". Pass `{ exact: true }` for those.
   *
   * `within` scopes the search to a container, e.g. `within: '[role=dialog]'`.
   *
   * `dom: true` dispatches `el.click()` instead of a synthesized mouse event at
   * the element's coordinates. Useful when a real mouse event is not needed and
   * hit-testing is in the way (overlays, transforms); a coordinate click is still
   * the default because it exercises the app the way a user does.
   */
  async clickText(
    text,
    {
      tag = "button, a, [role=button]",
      timeout = 15000,
      exact = false,
      within = null,
      dom = false,
    } = {},
  ) {
    const sel = `__cdp_click_target__`;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const found = await this.eval(`(() => {
        // Clear markers from previous clickText calls FIRST. The marker value is a
        // constant, so a leftover one from an earlier click makes the re-query
        // below resolve to that stale element instead of this one — silently
        // clicking the wrong control.
        document.querySelectorAll('[data-cdp]').forEach(e => e.removeAttribute('data-cdp'));
        const root = ${within ? `document.querySelector(${JSON.stringify(within)})` : "document"};
        if (!root) return false;
        const els = [...root.querySelectorAll(${JSON.stringify(tag)})];
        const want = ${JSON.stringify(text)};
        const el = els.find(e => {
          const t = (e.innerText || '').trim();
          return ${exact ? "t === want" : "t.includes(want)"};
        });
        if (!el) return false;
        if (el.disabled) return 'disabled';
        el.setAttribute('data-cdp', ${JSON.stringify(sel)});
        return true;
      })()`);
      if (found === "disabled") {
        throw new Error(`clickText: matched "${text}" but it is disabled`);
      }
      if (found) {
        if (dom) {
          await this.eval(
            `document.querySelector('[data-cdp="${sel}"]').click(), true`,
          );
          await sleep(120);
          return true;
        }
        return this.click(`[data-cdp="${sel}"]`);
      }
      await sleep(200);
    }
    throw new Error(
      `clickText timed out: ${text}${exact ? " (exact)" : ""}${within ? ` within ${within}` : ""}`,
    );
  }

  async url() {
    return this.eval("location.href");
  }

  async text() {
    return this.eval("document.body ? document.body.innerText : ''");
  }

  async screenshot(path, { fullPage = true } = {}) {
    const params = { format: "png" };
    if (fullPage) {
      const m = await this.send("Page.getLayoutMetrics");
      const h = Math.min(Math.ceil(m.cssContentSize.height), 16000);
      params.clip = {
        x: 0,
        y: 0,
        width: Math.ceil(m.cssContentSize.width),
        height: h,
        scale: 1,
      };
      params.captureBeyondViewport = true;
    }
    const { data } = await this.send("Page.captureScreenshot", params);
    writeFileSync(path, Buffer.from(data, "base64"));
    return path;
  }

  /**
   * Seed a token obtained from a real login into the zustand persist store.
   * localStorage is origin-scoped, so we must be on the origin before writing;
   * the store rehydrates from localStorage on the next document load.
   */
  async seedAuth(origin, { accessToken, refreshToken }) {
    await this.goto(origin);
    await this.eval(`(() => {
      localStorage.setItem('auth-store', JSON.stringify({
        state: { accessToken: ${JSON.stringify(accessToken)},
                 refreshToken: ${JSON.stringify(refreshToken ?? null)} },
        version: 0
      }));
    })()`);
  }

  drain() {
    const e = this.events.slice();
    this.events.length = 0;
    return e;
  }

  async close() {
    try {
      await this.send("Browser.close");
    } catch {
      /* already gone */
    }
    try {
      this.ws?.close();
    } catch {}
    const waitForExit = async (timeout) => {
      if (!this.proc || this.proc.exitCode !== null || this.proc.signalCode !== null) return true;
      return new Promise((resolveExit) => {
        const done = () => {
          clearTimeout(timer);
          resolveExit(true);
        };
        const timer = setTimeout(() => {
          this.proc.off("exit", done);
          resolveExit(false);
        }, timeout);
        this.proc.once("exit", done);
      });
    };
    if (this.proc && !(await waitForExit(300))) {
      this.proc.kill("SIGTERM");
      if (!(await waitForExit(1000))) {
        this.proc.kill("SIGKILL");
        if (!(await waitForExit(1000)))
          throw new Error("Chrome did not exit after SIGKILL; profile was not removed");
      }
    }
    if (this.ownsProfile) {
      try {
        rmSync(this.profileDir, { recursive: true, force: true });
      } catch {}
    }
  }
}

export async function launch(opts) {
  return new Browser(opts).launch();
}
