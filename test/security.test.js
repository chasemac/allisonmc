import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { main } from "../lib/cli.js";
import { lookupHash, sessionHash } from "../lib/codes.js";
import { TEST_FIXTURE_CODE, seedDemo } from "../lib/demo-fixture.js";
import { blobCredentials, createBlobMedia } from "../lib/blob-media.js";
import { loadEnvFile } from "../lib/cli.js";
import { createPostgresStore } from "../lib/postgres-store.js";
import { handle } from "../lib/router.js";
import { createMemoryServices } from "../lib/runtime.js";
import { redact } from "../lib/redact.js";
import { validatePresentation } from "../lib/schema.js";
import { detectMedia } from "../lib/media-types.js";
import { publicRelativePath } from "../lib/static-public.js";

const PEPPER = "test-pepper-not-secret-32chars!!";
const env = { RATE_LIMIT_MAX: "8", RATE_LIMIT_WINDOW_MS: "600000" };

async function setup() {
  const services = createMemoryServices({ CODE_PEPPER: PEPPER });
  await seedDemo(services);
  return services;
}

function accessRequest(code, { ip = "203.0.113.10", method = "POST", query = "", body } = {}) {
  return new Request(`http://127.0.0.1/api/access${query}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": ip,
    },
    body: method === "GET" || method === "HEAD" ? undefined : JSON.stringify(body === undefined ? { code } : body),
  });
}

function cookieHeader(response) {
  const cookie = response.headers.get("set-cookie") || "";
  const match = /amc_session=([^;]*)/.exec(cookie);
  return match && match[1] ? `amc_session=${match[1]}` : "";
}

async function unlock(services, code = TEST_FIXTURE_CODE, ip = "203.0.113.10") {
  const response = await handle(accessRequest(code, { ip }), { services, env });
  assert.equal(response.status, 200);
  return cookieHeader(response);
}

test("fixture code opens only its fictional project", async () => {
  const services = await setup();
  const logs = [];
  const response = await handle(accessRequest(TEST_FIXTURE_CODE), {
    services,
    env,
    log: (message) => logs.push(String(message)),
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.project.id, "demo-northglass");
  assert.equal(body.project.fictional, true);
  assert.equal(JSON.stringify(body).includes(TEST_FIXTURE_CODE), false);
  assert.equal(JSON.stringify(body).includes(lookupHash(TEST_FIXTURE_CODE, PEPPER)), false);
  assert.equal(response.headers.get("set-cookie").includes("HttpOnly"), true);
  assert.equal(response.headers.get("set-cookie").includes("SameSite=Strict"), true);
  assert.equal(response.headers.get("set-cookie").includes(TEST_FIXTURE_CODE), false);
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(logs.join("\n").includes(TEST_FIXTURE_CODE), false);
});

test("https requests set a secure cookie", async () => {
  const services = await setup();
  const response = await handle(
    new Request("https://preview.example/api/access", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.11" },
      body: JSON.stringify({ code: TEST_FIXTURE_CODE }),
    }),
    { services, env },
  );
  assert.equal(response.headers.get("set-cookie").includes("Secure"), true);
});

test("malformed, unknown, expired, and revoked codes are rejected", async () => {
  const services = await setup();
  const malformed = await handle(accessRequest("short"), { services, env });
  assert.equal(malformed.status, 400);
  const unknown = await handle(accessRequest("unknown-code-value-zzzzzz"), { services, env });
  assert.equal(unknown.status, 401);
  assert.equal((await unknown.json()).error, "That code is not valid.");
  await services.store.expireCode("demo-fixture-code-id", Date.now() - 1000);
  const expired = await handle(accessRequest(TEST_FIXTURE_CODE, { ip: "203.0.113.12" }), { services, env });
  assert.equal(expired.status, 401);
  assert.equal((await expired.json()).error, "This code has expired.");
  const fresh = await setup();
  await fresh.store.revokeCode("demo-fixture-code-id");
  const revoked = await handle(accessRequest(TEST_FIXTURE_CODE, { ip: "203.0.113.13" }), { services: fresh, env });
  assert.equal(revoked.status, 401);
  assert.equal((await revoked.json()).error, "This code has been revoked.");
});

test("a code in the query string never authenticates or reaches logs", async () => {
  const services = await setup();
  const logs = [];
  const response = await handle(accessRequest("", { query: `?code=${TEST_FIXTURE_CODE}`, body: {} }), {
    services,
    env,
    log: (message) => logs.push(String(message)),
  });
  assert.equal(response.status, 400);
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(logs.join("\n").includes(TEST_FIXTURE_CODE), false);
  const get = await handle(accessRequest(TEST_FIXTURE_CODE, { method: "GET", ip: "203.0.113.14" }), { services, env });
  assert.equal(get.status, 405);
});

test("rate limit is shared by callers and fails closed when the store throws", async () => {
  const services = await setup();
  const tight = { RATE_LIMIT_MAX: "2", RATE_LIMIT_WINDOW_MS: "60000" };
  const first = { store: services.store, media: services.media, pepper: services.pepper };
  const second = { store: services.store, media: services.media, pepper: services.pepper };
  assert.equal((await handle(accessRequest("bad-code-value-aaaaaaa", { ip: "198.51.100.8" }), { services: first, env: tight })).status, 401);
  assert.equal((await handle(accessRequest("bad-code-value-bbbbbbb", { ip: "198.51.100.8" }), { services: second, env: tight })).status, 401);
  const blocked = await handle(accessRequest(TEST_FIXTURE_CODE, { ip: "198.51.100.8" }), { services: first, env: tight });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get("set-cookie"), null);
  const logs = [];
  services.store.consumeRateLimit = async () => {
    throw new Error("postgres://user:secret@db.example/app down");
  };
  const closed = await handle(accessRequest(TEST_FIXTURE_CODE, { ip: "198.51.100.9" }), {
    services,
    env,
    log: (message) => logs.push(String(message)),
  });
  assert.equal(closed.status, 503);
  assert.equal(closed.headers.get("set-cookie"), null);
  assert.equal(await closed.text(), JSON.stringify({ error: "Project access is unavailable." }));
  assert.equal(logs.join("\n").includes("secret"), false);
});

test("sessions stay inside one project and die when expired, revoked, or logged out", async () => {
  const services = await setup();
  await services.store.upsertProject({
    id: "other-room",
    title: "Other Room Secret Title",
    summary: "A second fictional project used only by the security test.",
    fictional: true,
    sections: [{ id: "only", title: "Only", blocks: [{ type: "text", text: "Hidden cross project copy." }] }],
    attachments: [],
  });
  await services.store.putMedia({
    projectId: "other-room",
    mediaId: "secret",
    pathname: "projects/other-room/media/secret",
    contentType: "image/png",
    filename: "secret.png",
    byteLength: 12,
  });
  await services.media.put("projects/other-room/media/secret", Buffer.from("UNIQUEOTHERBYTES"), "image/png");
  const cookie = await unlock(services);
  const ok = await handle(new Request("http://127.0.0.1/api/projects/demo-northglass/presentation", { headers: { cookie } }), { services, env });
  assert.equal(ok.status, 200);
  const cross = await handle(new Request("http://127.0.0.1/api/projects/other-room/presentation", { headers: { cookie } }), { services, env });
  assert.equal(cross.status, 404);
  assert.equal((await cross.text()).includes("Other Room Secret Title"), false);
  const crossMedia = await handle(new Request("http://127.0.0.1/api/projects/other-room/media/secret", { headers: { cookie } }), { services, env });
  assert.equal(crossMedia.status, 404);
  assert.equal((await crossMedia.text()).includes("UNIQUEOTHERBYTES"), false);

  const anon = await handle(new Request("http://127.0.0.1/api/projects/demo-northglass/media/plan"), { services, env });
  assert.equal(anon.status, 401);
  assert.equal(Buffer.from(await anon.arrayBuffer())[0] === 0x89, false);

  const owned = await handle(new Request("http://127.0.0.1/api/projects/demo-northglass/media/plan", { headers: { cookie } }), { services, env });
  assert.equal(owned.status, 200);
  assert.equal(owned.headers.get("x-content-type-options"), "nosniff");
  assert.equal(Buffer.from(await owned.arrayBuffer())[0], 0x89);

  const traversal = [
    "http://127.0.0.1/api/projects/demo-northglass/media/..%2f..%2fsecret",
    "http://127.0.0.1/api/projects/demo-northglass/media/%2e%2e",
    "http://127.0.0.1/api/projects/..%2fetc/presentation",
    "http://127.0.0.1/api/projects/demo-northglass/media/....",
  ];
  for (const url of traversal) {
    const response = await handle(new Request(url, { headers: { cookie } }), { services, env });
    assert.notEqual(response.status, 200);
    assert.equal((await response.text()).includes("UNIQUEOTHERBYTES"), false);
  }

  const token = cookie.split("=")[1];
  await services.store.expireSession(sessionHash(token), Date.now() - 1000);
  const stale = await handle(new Request("http://127.0.0.1/api/projects/demo-northglass/presentation", { headers: { cookie } }), { services, env });
  assert.equal(stale.status, 401);

  const again = await unlock(services, TEST_FIXTURE_CODE, "203.0.113.40");
  await services.store.revokeCode("demo-fixture-code-id");
  const afterRevoke = await handle(new Request("http://127.0.0.1/api/projects/demo-northglass/presentation", { headers: { cookie: again } }), { services, env });
  assert.equal(afterRevoke.status, 401);

  const third = await setup();
  const live = await unlock(third, TEST_FIXTURE_CODE, "203.0.113.41");
  const bye = await handle(new Request("http://127.0.0.1/api/logout", { method: "POST", headers: { cookie: live } }), { services: third, env });
  assert.equal(bye.status, 200);
  const replay = await handle(new Request("http://127.0.0.1/api/projects/demo-northglass/media/plan", { headers: { cookie: live } }), { services: third, env });
  assert.equal(replay.status, 401);
  assert.equal(Buffer.from(await replay.arrayBuffer()).includes(Buffer.from("UNIQUEOTHERBYTES")), false);
});

test("attachment links cannot redirect and corrupt records fail closed", async () => {
  const services = await setup();
  const cookie = await unlock(services, TEST_FIXTURE_CODE, "203.0.113.50");
  const file = await handle(new Request("http://127.0.0.1/api/projects/demo-northglass/attachments/notes", { headers: { cookie } }), { services, env });
  assert.equal(file.status, 200);
  assert.match(file.headers.get("content-disposition"), /^attachment; filename="fictional-notes.pdf"$/);
  assert.equal(file.headers.get("content-type"), "application/pdf");
  assert.equal(file.headers.get("cache-control"), "private, no-store");
  assert.equal(file.headers.get("referrer-policy"), "no-referrer");
  const link = await handle(new Request("http://127.0.0.1/api/projects/demo-northglass/attachments/example-link", { headers: { cookie } }), { services, env });
  assert.equal(link.status, 404);
  assert.equal(link.headers.get("location"), null);
  services.store.projects.set("demo-northglass", { id: "demo-northglass", html: "<script>alert(1)</script>" });
  const corrupt = await handle(new Request("http://127.0.0.1/api/projects/demo-northglass/presentation", { headers: { cookie } }), { services, env });
  assert.equal(corrupt.status, 503);
  assert.equal((await corrupt.text()).includes("<script>"), false);
});

test("hosted runtimes without private stores fail closed", async () => {
  const missing = await handle(accessRequest(TEST_FIXTURE_CODE), {
    env: { VERCEL: "1", NODE_ENV: "production" },
    log() {},
  });
  assert.equal(missing.status, 503);
  assert.equal((await missing.text()).includes("DATABASE_URL"), false);
  const memory = await handle(accessRequest(TEST_FIXTURE_CODE, { ip: "203.0.113.60" }), {
    env: { VERCEL: "1", DATA_STORE: "memory", MEDIA_STORE: "memory", CODE_PEPPER: PEPPER },
    log() {},
  });
  assert.equal(memory.status, 503);
  const demoOnProd = await handle(accessRequest(TEST_FIXTURE_CODE, { ip: "203.0.113.61" }), {
    env: {
      VERCEL: "1",
      VERCEL_ENV: "production",
      DEMO_FIXTURE: "1",
      DATA_STORE: "postgres",
      MEDIA_STORE: "blob",
      DATABASE_URL: "postgres://user:secret@localhost/db",
      CODE_PEPPER: PEPPER,
      BLOB_READ_WRITE_TOKEN: "blob-token",
    },
    log() {},
  });
  assert.equal(demoOnProd.status, 503);
  assert.equal((await demoOnProd.text()).includes("secret"), false);
});

test("uploads that are not approved raster or pdf bytes are refused", () => {
  const samples = [
    "<svg xmlns='http://www.w3.org/2000/svg'></svg>",
    "<html><script>alert(1)</script></html>",
    "export default function hijack(){return 1}\n",
    "---\ntitle: notes\n",
    "# A markdown file\n",
  ];
  for (const sample of samples) assert.equal(detectMedia(Buffer.from(sample)), null);
});

test("schema rejects executable content and unsafe links", () => {
  const base = JSON.parse(readFileSync("fixtures/demo/project.json", "utf8"));
  assert.throws(() => validatePresentation({ ...base, sections: [{ id: "x", title: "X", blocks: [{ type: "html", html: "<script>" }] }] }));
  assert.throws(() => validatePresentation({
    ...base,
    attachments: [{ id: "bad", label: "Bad", kind: "link", href: "javascript:alert(1)" }],
  }));
  assert.throws(() => validatePresentation({
    ...base,
    attachments: [{ id: "bad", label: "Bad", kind: "link", href: "https://user:pass@example.com/a" }],
  }));
  assert.throws(() => validatePresentation({
    ...base,
    attachments: [{ id: "bad", label: "Bad", kind: "file", mediaId: "../secret", filename: "a.pdf" }],
  }));
});

test("renderer escapes text and drops unsafe links", () => {
  const source = readFileSync("js/view.js", "utf8");
  assert.equal(source.includes("innerHTML"), false);
  assert.equal(source.includes("insertAdjacentHTML"), false);
  assert.equal(source.includes(TEST_FIXTURE_CODE), false);
  class El {
    constructor(tag) {
      this.tagName = tag.toUpperCase();
      this.children = [];
      this.attrs = {};
      this.className = "";
    }
    set textContent(value) {
      this.stored = value == null ? "" : String(value);
      this.children = [];
    }
    get textContent() {
      if (this.children.length === 0) return this.stored || "";
      return this.children.map((child) => child.textContent || "").join("");
    }
    set innerHTML(_) {
      throw new Error("innerHTML");
    }
    append(...nodes) {
      this.stored = "";
      this.children.push(...nodes);
    }
    setAttribute(name, value) {
      this.attrs[name] = String(value);
    }
    addEventListener() {}
    querySelectorAll(selector) {
      const out = [];
      const visit = (node) => {
        if (selector === "img" ? node.tagName === "IMG" : selector === "script" ? node.tagName === "SCRIPT" : selector === "a" ? node.tagName === "A" : false) out.push(node);
        for (const child of node.children || []) visit(child);
      };
      for (const child of this.children) visit(child);
      return out;
    }
  }
  const title = new El("h1");
  const kicker = new El("p");
  const document = {
    createElement: (tag) => new El(tag),
    getElementById(id) {
      if (id === "page-title") return title;
      if (id === "page-kicker") return kicker;
      return null;
    },
  };
  const context = vm.createContext({ document, URL, globalThis: {} });
  context.globalThis = context;
  vm.runInContext(source, context);
  const root = new El("div");
  context.projectView.renderProject(root, {
    id: "demo-northglass",
    title: "<script>alert(1)</script>",
    summary: "Summary",
    fictional: true,
    sections: [{
      id: "overview",
      title: "Overview",
      blocks: [
        { type: "text", text: '<img src=x onerror=alert(1)>' },
        { type: "gallery", images: [{ mediaId: "plan", alt: "Plan", caption: "Cap" }] },
        { type: "attachment", attachmentId: "evil" },
        { type: "attachment", attachmentId: "ok" },
      ],
    }],
    attachments: [
      { id: "evil", label: "Evil", kind: "link", href: "javascript:alert(1)" },
      { id: "ok", label: "Example", kind: "link", href: "https://example.com/path" },
    ],
  });
  assert.equal(root.querySelectorAll("script").length, 0);
  assert.equal(root.textContent.includes("<img src=x onerror=alert(1)>"), true);
  assert.equal(title.textContent, "<script>alert(1)</script>");
  const hrefs = root.querySelectorAll("a").map((node) => node.href || node.attrs.href);
  assert.equal(hrefs.includes("javascript:alert(1)"), false);
  assert.equal(hrefs.includes("https://example.com/path"), true);
  assert.equal(context.projectView.isHttps("javascript:alert(1)"), "");
});

test("postgres queries stay parameterized and blob reads are private", async () => {
  const calls = [];
  function fakeSql(strings, ...values) {
    calls.push({ text: strings.join("?"), values });
    if (strings.join("").includes("RETURNING count")) return [{ count: 1 }];
    return [];
  }
  fakeSql.query = async (statement) => {
    calls.push({ text: statement, values: [] });
    return [];
  };
  const store = createPostgresStore(fakeSql);
  await store.getProject("abc' OR 1=1 --");
  assert.equal(calls.at(-1).values[0], "abc' OR 1=1 --");
  assert.equal(calls.at(-1).text.includes("OR 1=1"), false);
  const limit = await store.consumeRateLimit("access:203.0.113.9", { max: 5, windowMs: 60000, now: 120000 });
  assert.equal(limit.allowed, true);
  assert.equal(calls.at(-1).text.includes("ON CONFLICT"), true);
  const broken = () => {
    throw new Error("postgres://user:secret@host/db");
  };
  broken.query = broken;
  await assert.rejects(createPostgresStore(broken).consumeRateLimit("access:1", { max: 1, windowMs: 60000, now: 1 }), (err) => {
    assert.equal(String(err.message).includes("secret"), false);
    return true;
  });

  const seen = [];
  const previousToken = process.env.BLOB_READ_WRITE_TOKEN;
  const previousStore = process.env.BLOB_STORE_ID;
  process.env.BLOB_READ_WRITE_TOKEN = "process-token";
  process.env.BLOB_STORE_ID = "store_process";
  const media = createBlobMedia({
    env: { BLOB_READ_WRITE_TOKEN: "loaded-token", BLOB_STORE_ID: "store_loaded" },
    client: {
      async put(pathname, _bytes, options) {
        seen.push(options);
        return { pathname, url: "https://store.example/private?sig=secret" };
      },
      async get(pathname, options) {
        seen.push(options);
        return { statusCode: 200, stream: new Blob(["x"]).stream(), blob: { contentType: "image/png" } };
      },
    },
  });
  try {
    const saved = await media.put("projects/demo-northglass/media/plan", Buffer.from([0x89]), "image/png");
    assert.deepEqual(saved, { pathname: "projects/demo-northglass/media/plan" });
    assert.equal(seen[0].access, "private");
    assert.equal(seen[0].addRandomSuffix, false);
    assert.equal(seen[0].token, "loaded-token");
    assert.equal(seen[0].storeId, "store_loaded");
    await media.get("projects/demo-northglass/media/plan");
    assert.equal(seen[1].access, "private");
    assert.equal(seen[1].token, "loaded-token");
    await assert.rejects(() => media.get("../secret"));
  } finally {
    if (previousToken === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
    else process.env.BLOB_READ_WRITE_TOKEN = previousToken;
    if (previousStore === undefined) delete process.env.BLOB_STORE_ID;
    else process.env.BLOB_STORE_ID = previousStore;
  }
});

test("blob credentials come from the selected env and hosted oidc is refreshed per call", async () => {
  const previousToken = process.env.BLOB_READ_WRITE_TOKEN;
  const previousStore = process.env.BLOB_STORE_ID;
  process.env.BLOB_READ_WRITE_TOKEN = "process-token";
  process.env.BLOB_STORE_ID = "store_process";
  try {
    const dir = await mkdtemp(path.join(tmpdir(), "amc-env-"));
    const file = path.join(dir, "env");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(file, "BLOB_READ_WRITE_TOKEN=loaded-token\nBLOB_STORE_ID=store_loaded\n");
    const loaded = loadEnvFile({ ...process.env, AMC_ENV_FILE: file });
    const creds = await blobCredentials(loaded);
    assert.equal(creds.token, "loaded-token");
    assert.equal(creds.storeId, "store_loaded");
    assert.equal(creds.oidcToken, undefined);
    let issued = 0;
    const first = await blobCredentials(
      { VERCEL: "1", BLOB_STORE_ID: "store_loaded", BLOB_READ_WRITE_TOKEN: "loaded-token" },
      async () => {
        issued += 1;
        return issued === 1 ? "oidc-one" : "oidc-two";
      },
    );
    const second = await blobCredentials(
      { VERCEL: "1", BLOB_STORE_ID: "store_loaded", BLOB_READ_WRITE_TOKEN: "loaded-token" },
      async () => "oidc-two",
    );
    assert.equal(first.oidcToken, "oidc-one");
    assert.equal(first.token, undefined);
    assert.equal(first.storeId, "store_loaded");
    assert.equal(second.oidcToken, "oidc-two");
    assert.equal(second.storeId, "store_loaded");
  } finally {
    if (previousToken === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
    else process.env.BLOB_READ_WRITE_TOKEN = previousToken;
    if (previousStore === undefined) delete process.env.BLOB_STORE_ID;
    else process.env.BLOB_STORE_ID = previousStore;
  }
});

test("a media outage grants no session and a failed logout keeps it", async () => {
  const services = await setup();
  services.media.probe = async () => {
    throw new Error("blob down");
  };
  const denied = await handle(accessRequest(TEST_FIXTURE_CODE, { ip: "203.0.113.70" }), { services, env });
  assert.equal(denied.status, 503);
  assert.equal(denied.headers.get("set-cookie"), null);

  const open = await setup();
  const cookie = await unlock(open, TEST_FIXTURE_CODE, "203.0.113.71");
  open.store.revokeSession = async () => {
    throw new Error("db down");
  };
  const bye = await handle(
    new Request("http://127.0.0.1/api/logout", { method: "POST", headers: { cookie } }),
    { services: open, env },
  );
  assert.equal(bye.status, 503);
  assert.equal(bye.headers.get("set-cookie"), null);
  const again = await handle(new Request("http://127.0.0.1/api/session", { headers: { cookie } }), { services: open, env });
  assert.equal(again.status, 200);
  assert.equal((await again.json()).authenticated, true);
});

test("public paths and the operator state file do not disclose codes", async () => {
  assert.equal(publicRelativePath("/lib/demo-fixture.js"), null);
  assert.equal(publicRelativePath("/assets/img/../lib/demo-fixture.js"), null);
  assert.equal(publicRelativePath("/index.html"), "index.html");
  assert.equal(redact('postgres://user:secret@host/db CODE_PEPPER=abc amc_session=tok "code":"abc"').includes("secret"), false);

  const dir = await mkdtemp(path.join(tmpdir(), "amc-"));
  const state = path.join(dir, "state.json");
  const project = path.join(dir, "project.json");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(project, readFileSync("fixtures/demo/project.json"));
  const stdout = { text: "", write(chunk) { this.text += chunk; } };
  const stderr = { text: "", write(chunk) { this.text += chunk; } };
  const io = { stdout, stderr };
  const cliEnv = { CODE_PEPPER: PEPPER };
  assert.equal(await main(["put-project", "--store", "memory", "--state", state, "--file", project], cliEnv, io), 0);
  assert.equal(await main(["put-media", "--store", "memory", "--state", state, "--project", "demo-northglass", "--id", "plan", "--file", "fixtures/demo/plan.png"], cliEnv, io), 0);
  stdout.text = "";
  assert.equal(await main(["issue-code", "--store", "memory", "--state", state, "--project", "demo-northglass", "--days", "7", "--label", "review"], cliEnv, io), 0);
  const match = /^code: ([A-Za-z0-9_-]{43})$/m.exec(stdout.text);
  if (!match) throw new Error("issue-code did not print a code line");
  const issued = match[1];
  const saved = await readFile(state, "utf8");
  if (saved.includes(issued)) throw new Error("state file stored a raw code");
  assert.equal(saved.includes(lookupHash(issued, PEPPER)), true);
  const bad = path.join(dir, "bad.json");
  writeFileSync(bad, JSON.stringify({ ...JSON.parse(readFileSync("fixtures/demo/project.json", "utf8")), sections: [{ id: "x", title: "X", blocks: [{ type: "html", html: "<script>" }] }] }));
  assert.equal(await main(["put-project", "--store", "memory", "--state", state, "--file", bad], cliEnv, io), 1);
  const svg = path.join(dir, "x.svg");
  writeFileSync(svg, "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>");
  assert.equal(await main(["put-media", "--store", "memory", "--state", state, "--project", "demo-northglass", "--id", "svg", "--file", svg], cliEnv, io), 1);
});
