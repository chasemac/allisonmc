import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sessionHash } from "../lib/codes.js";
import { TEST_FIXTURE_CODE, seedDemo } from "../lib/demo-fixture.js";
import {
  BODY_TOO_LARGE,
  MAX_JSON_BYTES,
  PAGE_CSP,
  PAGE_PERMISSIONS,
  clientIp,
  contentLengthOver,
  forwardedClientHeaders,
  json,
  pageResponseHeaders,
  readLimitedBuffer,
} from "../lib/http.js";
import { safeFilename } from "../lib/media-types.js";
import { handle } from "../lib/router.js";
import { createMemoryServices } from "../lib/runtime.js";

const PEPPER = "test-pepper-not-secret-32chars!!";
const env = { RATE_LIMIT_MAX: "8", RATE_LIMIT_WINDOW_MS: "600000" };

async function setup() {
  const services = createMemoryServices({ CODE_PEPPER: PEPPER });
  await seedDemo(services);
  return services;
}

function accessRequest(code, { ip = "203.0.113.10", method = "POST", headers = {}, body } = {}) {
  const payload = body === undefined ? JSON.stringify({ code }) : body;
  return new Request("http://127.0.0.1/api/access", {
    method,
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": ip,
      ...headers,
    },
    body: method === "GET" || method === "HEAD" ? undefined : payload,
  });
}

function cookieHeader(response) {
  const match = /amc_session=([^;]*)/.exec(response.headers.get("set-cookie") || "");
  return match && match[1] ? `amc_session=${match[1]}` : "";
}

function maxAge(response) {
  const match = /Max-Age=(\d+)/.exec(response.headers.get("set-cookie") || "");
  return match ? Number(match[1]) : null;
}

async function unlock(services, ip) {
  const response = await handle(accessRequest(TEST_FIXTURE_CODE, { ip }), { services, env });
  assert.equal(response.status, 200);
  return cookieHeader(response);
}

test("the session cookie stays host-only, httpOnly, and within 12 hours", async () => {
  const services = await setup();
  const response = await handle(accessRequest(TEST_FIXTURE_CODE, { ip: "203.0.113.150" }), { services, env });
  const cookie = response.headers.get("set-cookie") || "";
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Path=\//);
  assert.equal(/domain=/i.test(cookie), false);
  assert.equal(cookie.includes("Secure"), false);
  const age = maxAge(response);
  assert.ok(age <= 12 * 60 * 60);
  assert.ok(age >= 12 * 60 * 60 - 5);

  await services.store.expireCode("demo-fixture-code-id", Date.now() + 45_000);
  const short = await handle(accessRequest(TEST_FIXTURE_CODE, { ip: "203.0.113.151" }), { services, env });
  assert.equal(short.status, 200);
  const shortAge = maxAge(short);
  assert.ok(shortAge <= 45);
  assert.ok(shortAge >= 30);
});

test("https keeps the secure flag when x-forwarded-proto says http", async () => {
  const services = await setup();
  const https = await handle(
    new Request("https://allisonmc.com/api/access", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "203.0.113.152",
        "x-forwarded-proto": "http",
      },
      body: JSON.stringify({ code: TEST_FIXTURE_CODE }),
    }),
    { services, env },
  );
  assert.match(https.headers.get("set-cookie") || "", /Secure/);

  const hidden = await handle(
    new Request("http://127.0.0.1/api/access", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "203.0.113.153",
        "x-forwarded-proto": "https, http",
      },
      body: JSON.stringify({ code: TEST_FIXTURE_CODE }),
    }),
    { services, env },
  );
  assert.equal((hidden.headers.get("set-cookie") || "").includes("Secure"), false);

  const appended = await handle(
    new Request("http://127.0.0.1/api/access", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "203.0.113.154",
        "x-forwarded-proto": "http, https",
      },
      body: JSON.stringify({ code: TEST_FIXTURE_CODE }),
    }),
    { services, env },
  );
  assert.match(appended.headers.get("set-cookie") || "", /Secure/);
});

test("a dead or duplicate session cookie is cleared and a store outage keeps it", async () => {
  const services = await setup();
  const cookie = await unlock(services, "203.0.113.160");
  const token = cookie.split("=")[1];
  const presentation = "http://127.0.0.1/api/projects/demo-northglass/presentation";

  const duplicate = await handle(
    new Request(presentation, { headers: { cookie: `${cookie}; amc_session=${"b".repeat(43)}` } }),
    { services, env },
  );
  assert.equal(duplicate.status, 401);
  assert.match(duplicate.headers.get("set-cookie") || "", /Max-Age=0/);
  assert.equal(duplicate.headers.get("cache-control"), "private, no-store");

  const live = await handle(new Request(presentation, { headers: { cookie } }), { services, env });
  assert.equal(live.status, 200);
  assert.equal(live.headers.get("cache-control"), "private, no-store");

  const other = await handle(new Request("http://127.0.0.1/api/projects/other-room/presentation", { headers: { cookie } }), {
    services,
    env,
  });
  assert.equal(other.status, 404);
  assert.equal(other.headers.get("set-cookie"), null);

  const anon = await handle(new Request(presentation), { services, env });
  assert.equal(anon.status, 401);
  assert.equal(anon.headers.get("set-cookie"), null);
  assert.equal(anon.headers.get("cache-control"), "private, no-store");

  const getLogout = await handle(new Request("http://127.0.0.1/api/logout", { method: "GET", headers: { cookie } }), {
    services,
    env,
  });
  assert.equal(getLogout.status, 405);
  assert.equal(getLogout.headers.get("set-cookie"), null);
  const still = await handle(new Request("http://127.0.0.1/api/session", { headers: { cookie } }), { services, env });
  assert.equal((await still.json()).authenticated, true);

  await services.store.expireSession(sessionHash(token), Date.now() - 1000);
  const stale = await handle(new Request("http://127.0.0.1/api/session", { headers: { cookie } }), { services, env });
  assert.equal(stale.status, 200);
  assert.equal((await stale.json()).authenticated, false);
  assert.match(stale.headers.get("set-cookie") || "", /Max-Age=0/);

  const fresh = await setup();
  const kept = await unlock(fresh, "203.0.113.161");
  fresh.store.getSession = async () => {
    throw new Error("ECONNREFUSED postgres://user:secret@db.example/app");
  };
  const down = await handle(new Request(presentation, { headers: { cookie: kept } }), { services: fresh, env });
  assert.equal(down.status, 503);
  assert.equal(down.headers.get("set-cookie"), null);
  const downText = await down.text();
  assert.equal(downText.includes("secret"), false);
  assert.equal(downText.includes("ECONNREFUSED"), false);
});

test("vercel's forwarded header wins over a client-supplied address", async () => {
  const services = await setup();
  const tight = { RATE_LIMIT_MAX: "1", RATE_LIMIT_WINDOW_MS: "60000", RATE_LIMIT_GLOBAL_MAX: "10" };
  function attempt(vercel, spoofed) {
    return handle(
      new Request("http://127.0.0.1/api/access", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-vercel-forwarded-for": vercel,
          "x-forwarded-for": spoofed,
          "x-real-ip": spoofed,
        },
        body: JSON.stringify({ code: "unknown-code-value-zzzzzz" }),
      }),
      { services, env: tight },
    );
  }
  assert.equal((await attempt("203.0.113.10", "198.51.100.1")).status, 401);
  assert.equal((await attempt("203.0.113.10", "198.51.100.2")).status, 429);
  assert.equal((await attempt("203.0.113.11", "198.51.100.2")).status, 401);

  const collapsed = { RATE_LIMIT_MAX: "1", RATE_LIMIT_WINDOW_MS: "60000", RATE_LIMIT_GLOBAL_MAX: "10" };
  const bucket = await setup();
  function bad(spoofed) {
    return handle(
      new Request("http://127.0.0.1/api/access", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-vercel-forwarded-for": "not an ip",
          "x-forwarded-for": spoofed,
        },
        body: JSON.stringify({ code: "unknown-code-value-zzzzzz" }),
      }),
      { services: bucket, env: collapsed },
    );
  }
  assert.equal((await bad("203.0.113.30")).status, 401);
  assert.equal((await bad("203.0.113.31")).status, 429);
  assert.equal(clientIp(new Request("http://127.0.0.1/", { headers: { "x-forwarded-for": "203.0.113.40" } })), "203.0.113.40");
});

test("a global attempt cap stops a new address after the shared budget is spent", async () => {
  const services = await setup();
  const tight = { RATE_LIMIT_MAX: "1", RATE_LIMIT_WINDOW_MS: "60000", RATE_LIMIT_GLOBAL_MAX: "2" };
  async function status(ip, code) {
    const response = await handle(accessRequest(code, { ip }), { services, env: tight });
    return response;
  }
  assert.equal((await status("203.0.113.41", "bad-code-value-aaaaaaa")).status, 401);
  assert.equal((await status("203.0.113.41", "bad-code-value-bbbbbbb")).status, 429);
  assert.equal((await status("203.0.113.42", "bad-code-value-ccccccc")).status, 401);
  const blocked = await status("203.0.113.43", TEST_FIXTURE_CODE);
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get("set-cookie"), null);
  assert.equal(blocked.headers.get("cache-control"), "private, no-store");
});

test("access bodies that are large, malformed, or the wrong method do not open a session", async () => {
  const services = await setup();
  const huge = await handle(
    accessRequest(TEST_FIXTURE_CODE, {
      ip: "203.0.113.170",
      body: JSON.stringify({ code: TEST_FIXTURE_CODE, pad: "x".repeat(3000) }),
    }),
    { services, env },
  );
  assert.equal(huge.status, 413);
  assert.equal(huge.headers.get("set-cookie"), null);
  assert.equal(huge.headers.get("cache-control"), "private, no-store");
  assert.equal((await huge.text()).includes(TEST_FIXTURE_CODE), false);

  const broken = await handle(accessRequest("", { ip: "203.0.113.171", body: "{" }), { services, env });
  assert.equal(broken.status, 400);
  const brokenText = await broken.text();
  assert.equal(brokenText.includes("SyntaxError"), false);
  assert.equal(brokenText.includes("Unexpected"), false);
  assert.equal(brokenText, JSON.stringify({ error: "Enter a valid code." }));

  const list = await handle(accessRequest("", { ip: "203.0.113.172", body: "[]" }), { services, env });
  assert.equal(list.status, 400);
  assert.equal(list.headers.get("set-cookie"), null);

  const jsonp = await handle(
    accessRequest(TEST_FIXTURE_CODE, { ip: "203.0.113.173", headers: { "content-type": "application/jsonp" } }),
    { services, env },
  );
  assert.equal(jsonp.status, 415);
  assert.equal(jsonp.headers.get("set-cookie"), null);

  const put = await handle(accessRequest(TEST_FIXTURE_CODE, { ip: "203.0.113.174", method: "PUT" }), { services, env });
  assert.equal(put.status, 405);
  assert.equal(put.headers.get("set-cookie"), null);
  assert.equal(put.headers.get("access-control-allow-origin"), null);

  const typed = await handle(
    accessRequest(TEST_FIXTURE_CODE, {
      ip: "203.0.113.175",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ code: TEST_FIXTURE_CODE, note: "ignored" }),
    }),
    { services, env },
  );
  assert.equal(typed.status, 200);
  assert.match(typed.headers.get("set-cookie") || "", /HttpOnly/);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`{"code":"${TEST_FIXTURE_CODE}","pad":"`));
      controller.enqueue(encoder.encode("y".repeat(MAX_JSON_BYTES)));
      controller.enqueue(encoder.encode('"}'));
      controller.close();
    },
  });
  const chunked = await handle(
    new Request("http://127.0.0.1/api/access", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.176" },
      body: stream,
      duplex: "half",
    }),
    { services, env },
  );
  assert.equal(chunked.status, 413);
  assert.equal(chunked.headers.get("set-cookie"), null);

  const misconfigured = await handle(accessRequest("bad-code-value-ddddddd", { ip: "203.0.113.177" }), {
    services,
    env: { RATE_LIMIT_MAX: "8", RATE_LIMIT_WINDOW_MS: "60000", RATE_LIMIT_GLOBAL_MAX: "1" },
  });
  assert.equal(misconfigured.status, 503);
  assert.equal(misconfigured.headers.get("set-cookie"), null);
});

test("media and widgets ignore range, keep nosniff, and refuse unsafe download names", async () => {
  const services = await setup();
  const cookie = await unlock(services, "203.0.113.180");
  const mediaUrl = "http://127.0.0.1/api/projects/demo-northglass/media/plan";
  const full = await handle(new Request(mediaUrl, { headers: { cookie } }), { services, env });
  const ranged = await handle(
    new Request(mediaUrl, { headers: { cookie, range: "bytes=0-0" } }),
    { services, env },
  );
  const fullBytes = Buffer.from(await full.arrayBuffer());
  const rangedBytes = Buffer.from(await ranged.arrayBuffer());
  assert.equal(ranged.status, 200);
  assert.equal(ranged.headers.get("content-range"), null);
  assert.equal(ranged.headers.get("accept-ranges"), "none");
  assert.equal(ranged.headers.get("x-content-type-options"), "nosniff");
  assert.equal(ranged.headers.get("cache-control"), "private, no-store");
  assert.equal(ranged.headers.get("content-type"), "image/png");
  assert.equal(rangedBytes.length, fullBytes.length);
  assert.equal(rangedBytes[0], 0x89);

  const widgetUrl = "http://127.0.0.1/api/projects/demo-northglass/widgets/sketch/open";
  const widget = await handle(new Request(widgetUrl, { headers: { cookie, range: "bytes=0-3" } }), { services, env });
  const whole = await handle(new Request(widgetUrl, { headers: { cookie } }), { services, env });
  assert.equal(widget.status, 200);
  assert.equal(widget.headers.get("accept-ranges"), "none");
  assert.equal(widget.headers.get("cache-control"), "private, no-store");
  assert.equal(widget.headers.get("x-content-type-options"), "nosniff");
  assert.equal(Buffer.from(await widget.arrayBuffer()).length, Buffer.from(await whole.arrayBuffer()).length);

  await services.store.putMedia({
    projectId: "demo-northglass",
    mediaId: "notes",
    pathname: "projects/demo-northglass/media/notes",
    contentType: "application/pdf",
    filename: "notes.pdf\r\nX-Injected: yes",
    byteLength: 8,
  });
  const injected = await handle(
    new Request("http://127.0.0.1/api/projects/demo-northglass/media/notes", { headers: { cookie } }),
    { services, env },
  );
  assert.equal(injected.status, 200);
  assert.equal(injected.headers.get("content-disposition"), 'attachment; filename="download"');
  assert.equal(injected.headers.get("x-injected"), null);
  assert.equal(injected.headers.get("content-type"), "application/pdf");
  assert.equal(injected.headers.get("x-content-type-options"), "nosniff");
  assert.equal(injected.headers.get("cache-control"), "private, no-store");

  await services.store.putMedia({
    projectId: "demo-northglass",
    mediaId: "notes",
    pathname: "projects/demo-northglass/media/notes",
    contentType: "application/pdf",
    filename: "../../secret.pdf",
    byteLength: 8,
  });
  const traversed = await handle(
    new Request("http://127.0.0.1/api/projects/demo-northglass/media/notes", { headers: { cookie } }),
    { services, env },
  );
  assert.equal(traversed.headers.get("content-disposition"), 'attachment; filename="secret.pdf"');
  assert.equal((traversed.headers.get("content-disposition") || "").includes(".."), false);

  assert.equal(safeFilename("."), null);
  assert.equal(safeFilename(".."), null);
  assert.equal(safeFilename('quote".pdf'), null);
  assert.equal(safeFilename("notes.pdf"), "notes.pdf");
});

test("a media or session-store failure is a 503 with no internals and no session cookie", async () => {
  const services = await setup();
  services.store.insertSession = async () => {
    throw new Error("postgres://user:secret@db.example/app insert failed");
  };
  const logs = [];
  const denied = await handle(accessRequest(TEST_FIXTURE_CODE, { ip: "203.0.113.190" }), {
    services,
    env,
    log: (message) => logs.push(String(message)),
  });
  assert.equal(denied.status, 503);
  assert.equal(denied.headers.get("set-cookie"), null);
  assert.equal(denied.headers.get("cache-control"), "private, no-store");
  assert.equal(await denied.text(), JSON.stringify({ error: "Project access is unavailable." }));
  assert.equal(logs.join("\n").includes("secret"), false);

  const open = await setup();
  const cookie = await unlock(open, "203.0.113.191");
  const seen = [];
  open.store.getProject = async () => {
    throw new Error("postgres://user:secret@db.example/app vercel_blob_rw_SECRET Bearer abc.def");
  };
  const presentation = await handle(
    new Request("http://127.0.0.1/api/projects/demo-northglass/presentation", { headers: { cookie } }),
    { services: open, env, log: (message) => seen.push(String(message)) },
  );
  assert.equal(presentation.status, 503);
  assert.equal(presentation.headers.get("set-cookie"), null);
  const text = await presentation.text();
  assert.equal(text.includes("secret"), false);
  assert.equal(text.includes("SECRET"), false);
  assert.equal(text.includes("Bearer"), false);
  const logged = seen.join("\n");
  assert.equal(logged.includes("secret"), false);
  assert.equal(logged.includes("SECRET"), false);
  assert.equal(logged.includes("Bearer abc"), false);
  assert.match(logged, /postgres:\/\/\[redacted\]/);

  const bytes = await setup();
  const mediaCookie = await unlock(bytes, "203.0.113.192");
  bytes.media.get = async () => {
    throw new Error("blob read failed vercel_blob_rw_SECRET");
  };
  const file = await handle(
    new Request("http://127.0.0.1/api/projects/demo-northglass/media/plan", { headers: { cookie: mediaCookie } }),
    { services: bytes, env },
  );
  assert.equal(file.status, 503);
  assert.equal(file.headers.get("cache-control"), "private, no-store");
  const payload = await file.text();
  assert.equal(payload.includes("SECRET"), false);
  assert.equal(payload.includes("\x89"), false);
});

test("local forwarding headers come from the socket and page headers stay compatible with Lato", async () => {
  const headers = forwardedClientHeaders(
    {
      "x-forwarded-for": "203.0.113.8",
      "x-vercel-forwarded-for": "198.51.100.9",
      "x-forwarded-proto": "https",
      "x-real-ip": "203.0.113.8",
      forwarded: "for=203.0.113.8",
      "content-type": "application/json",
      cookie: "amc_session=abc",
      host: "evil.example",
    },
    "::ffff:127.0.0.1",
  );
  assert.equal(headers.get("x-forwarded-for"), "127.0.0.1");
  assert.equal(headers.get("x-vercel-forwarded-for"), null);
  assert.equal(headers.get("x-forwarded-proto"), null);
  assert.equal(headers.get("x-real-ip"), null);
  assert.equal(headers.get("forwarded"), null);
  assert.equal(headers.get("host"), null);
  assert.equal(headers.get("content-type"), "application/json");
  assert.equal(headers.get("cookie"), "amc_session=abc");
  assert.equal(clientIp(new Request("http://127.0.0.1/api/access", { headers })), "127.0.0.1");

  async function* tooBig() {
    yield Buffer.alloc(1500);
    yield Buffer.alloc(1500);
  }
  assert.equal(await readLimitedBuffer(tooBig(), MAX_JSON_BYTES), BODY_TOO_LARGE);
  assert.equal(contentLengthOver(new Request("http://127.0.0.1/api/access", { method: "POST", headers: { "content-length": "9000" } })), true);

  const locked = json(401, { error: "Your session has ended." }, { "cache-control": "public, max-age=600" });
  assert.equal(locked.headers.get("cache-control"), "private, no-store");
  assert.equal(locked.headers.get("x-content-type-options"), "nosniff");

  const local = pageResponseHeaders("text/html; charset=utf-8");
  assert.equal(local["content-security-policy"], PAGE_CSP);
  assert.match(PAGE_CSP, /style-src 'self' https:\/\/fonts\.googleapis\.com/);
  assert.match(PAGE_CSP, /font-src 'self' https:\/\/fonts\.gstatic\.com/);
  assert.match(PAGE_CSP, /script-src 'self'/);
  assert.match(PAGE_CSP, /connect-src 'self'/);
  assert.equal(PAGE_CSP.includes("unsafe-inline"), false);
  assert.equal(PAGE_CSP.includes("upgrade-insecure-requests"), false);
  assert.equal(Object.values(local).join("\n").includes("upgrade-insecure-requests"), false);

  const server = readFileSync("server.mjs", "utf8");
  assert.equal(server.includes("upgrade-insecure-requests"), false);
  assert.equal(server.includes("includeSubDomains"), false);

  const config = JSON.parse(readFileSync("vercel.json", "utf8"));
  const page = config.headers.find((item) => item.source === "/((?!api/).*)");
  const csp = page.headers.find((item) => item.key === "Content-Security-Policy").value;
  assert.equal(csp, `${PAGE_CSP}; upgrade-insecure-requests`);
  assert.equal(page.headers.find((item) => item.key === "Permissions-Policy").value, PAGE_PERMISSIONS);
  assert.equal(page.headers.find((item) => item.key === "Strict-Transport-Security").value, "max-age=15552000");
  assert.equal(page.headers.find((item) => item.key === "X-Frame-Options").value, "DENY");
  const api = config.headers.find((item) => item.source === "/api/(.*)");
  assert.equal(api.headers.find((item) => item.key === "Cache-Control").value, "private, no-store");
  assert.equal(api.headers.find((item) => item.key === "X-Content-Type-Options").value, "nosniff");
  assert.equal(api.headers.some((item) => item.key === "Content-Security-Policy"), false);
  assert.equal(api.headers.some((item) => item.key === "X-Frame-Options"), false);
});
