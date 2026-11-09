import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readPublicFile } from "../lib/static-public.js";

const SENTINEL = "SENTINEL-CODE-NOT-A-SECRET";

// CHROME_PATH wins. Otherwise use google-chrome on PATH, the macOS app, or a
// Playwright Chromium download, so the test runs on a Mac too.
function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
      if (dir && existsSync(path.join(dir, name))) return path.join(dir, name);
    }
  }
  const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (existsSync(mac)) return mac;
  for (const cache of [path.join(homedir(), "Library/Caches/ms-playwright"), path.join(homedir(), ".cache/ms-playwright")]) {
    if (!existsSync(cache)) continue;
    for (const build of readdirSync(cache).filter((name) => /^chromium-\d+$/.test(name)).sort().reverse()) {
      for (const rel of [
        "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
        "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
        "chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
        "chrome-linux64/chrome",
        "chrome-linux/chrome",
      ]) {
        if (existsSync(path.join(cache, build, rel))) return path.join(cache, build, rel);
      }
    }
  }
  return null;
}
const CHROME = findChrome();

function listen() {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    requests.push(`${req.method} ${url.pathname}${url.search}`);
    const file = await readPublicFile(process.cwd(), url.pathname);
    if (!file) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("missing");
      return;
    }
    res.writeHead(200, { "content-type": file.contentType });
    res.end(file.bytes);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, requests }));
  });
}

function send(ws, method, params = {}) {
  const id = send.next++;
  const payload = JSON.stringify({ id, method, params });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 8000);
    send.pending.set(id, (message) => {
      clearTimeout(timer);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    });
    ws.send(payload);
  });
}
send.next = 1;
send.pending = new Map();

test("a browser with scripts disabled cannot submit the project code", { skip: CHROME ? false : "no Chrome found; set CHROME_PATH" }, async () => {
  const { server, port, requests } = await listen();
  const profile = await mkdtemp(path.join(tmpdir(), "amc-chrome-"));
  const stderr = [];
  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      `--user-data-dir=${profile}`,
      "--disable-javascript",
      "--remote-debugging-port=9333",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  chrome.stderr.on("data", (chunk) => {
    stderr.push(chunk.toString());
    if (stderr.join("").length > 4000) stderr.shift();
  });
  try {
    let page;
    for (let attempt = 0; attempt < 40 && !page; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      try {
        const targets = await fetch("http://127.0.0.1:9333/json/list").then((response) => response.json());
        page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
      } catch {
        page = null;
      }
    }
    assert.ok(page, `chrome did not open a page\n${stderr.join("").slice(-500)}`);
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve);
      ws.addEventListener("error", reject);
    });
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id && send.pending.has(message.id)) {
        const resolve = send.pending.get(message.id);
        send.pending.delete(message.id);
        resolve(message);
      }
    });
    await send(ws, "Page.enable");
    await send(ws, "DOM.enable");
    await send(ws, "Page.navigate", { url: `http://127.0.0.1:${port}/view.html` });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const document = await send(ws, "DOM.getDocument");
    const input = await send(ws, "DOM.querySelector", { nodeId: document.root.nodeId, selector: "#project-code" });
    const button = await send(ws, "DOM.querySelector", { nodeId: document.root.nodeId, selector: "#access-submit" });
    assert.ok(input.nodeId);
    assert.ok(button.nodeId);
    await send(ws, "DOM.focus", { nodeId: input.nodeId });
    for (const key of SENTINEL) {
      await send(ws, "Input.dispatchKeyEvent", { type: "keyDown", text: key, key });
      await send(ws, "Input.dispatchKeyEvent", { type: "keyUp", key });
    }
    await send(ws, "Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await send(ws, "Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    const box = await send(ws, "DOM.getBoxModel", { nodeId: button.nodeId });
    const [x1, y1, x2, y2] = box.model.content;
    const x = (x1 + x2) / 2;
    const y = (y1 + y2) / 2;
    await send(ws, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await send(ws, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const history = await send(ws, "Page.getNavigationHistory");
    const current = history.entries[history.currentIndex];
    assert.equal(current.url.includes("code="), false);
    assert.equal(current.url.includes(SENTINEL), false);
    assert.equal(requests.some((entry) => entry.includes(SENTINEL) || entry.includes("code=")), false);
    ws.close();
  } finally {
    chrome.kill("SIGKILL");
    await new Promise((resolve) => server.close(resolve));
  }
});
