import assert from "node:assert/strict";
import { mkdtemp, open, readFile, symlink, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { main } from "../lib/cli.js";
import { colladaProblems, exactAssetReference, wrapWidgetDocument } from "../lib/content-policy.js";
import { mediaPath } from "../lib/codes.js";
import { approveSnapshot, canonicalDigest, deriveStrippedSnapshot, inspectSnapshot, publishSnapshot, sealSnapshot } from "../lib/ingest.js";
import { MAX_MEDIA_BYTES } from "../lib/media-types.js";
import { createPostgresStore } from "../lib/postgres-store.js";
import { handle } from "../lib/router.js";
import { createMemoryServices } from "../lib/runtime.js";
import { SchemaError } from "../lib/errors.js";

const PEPPER = "test-pepper-not-secret-32chars!!";
const env = { RATE_LIMIT_MAX: "8", RATE_LIMIT_WINDOW_MS: "600000", CODE_PEPPER: PEPPER };
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082",
  "hex",
);
const CLEAN = "<!doctype html><html><head><style>body{color:#111}</style></head><body><p>Contained view</p><script>document.body.dataset.ready='1'</script></body></html>";
const NAV = `${CLEAN.slice(0, CLEAN.lastIndexOf("</body>"))}<script>const dest=new URL("/collect", location.href); location.assign(dest+"?origin="+location.origin);</script></body></html>`;

function registration(id, title = "Synthetic project") {
  return {
    id,
    title,
    summary: "Registered for private viewing. No submission is published yet.",
    fictional: false,
    sections: [{ id: "pending", title: "Pending", blocks: [{ type: "text", text: "This project is registered and has no published submission." }] }],
    attachments: [],
  };
}

async function writeClean(dir, { projectId = "proj_example_001", submissionId = "sub_example_010", html = CLEAN, dae = "<COLLADA></COLLADA>" } = {}) {
  const document = {
    projectId,
    submissionId,
    title: `Title ${submissionId}`,
    client: "Synthetic client",
    location: "Synthetic place",
    preparedBy: "Synthetic author",
    date: "2026-01-01",
    notesForReviewers: "Synthetic reviewer note.",
    content: { summary: "Synthetic summary for a private viewing test.", sections: [{ id: "overview", heading: "Overview", body: "Synthetic section body." }] },
    assets: [
      { path: "assets/viewer.html", role: "interactive-3d-viewer", note: "viewer" },
      { path: "assets/photo.png", role: "gallery", note: "photo" },
      { path: "assets/model-a.dae", role: "downloadable-3d-model", note: "model" },
    ],
  };
  const files = [
    ["content.json", Buffer.from(`${JSON.stringify(document)}\n`)],
    ["assets/viewer.html", Buffer.from(html)],
    ["assets/photo.png", PNG],
    ["assets/model-a.dae", Buffer.from(dae)],
  ];
  for (const [file, bytes] of files) {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), bytes);
  }
  const crypto = await import("node:crypto");
  const listed = files.map(([file, bytes]) => ({
    path: file,
    size: bytes.length,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
  }));
  const digest = canonicalDigest(projectId, submissionId, listed);
  await writeFile(path.join(dir, "READY.json"), JSON.stringify({ projectId, submissionId, digest, files: listed }));
  return { projectId, submissionId, digest };
}

async function publishClean(services, dir) {
  const inspected = await inspectSnapshot(dir);
  await sealSnapshot(services, inspected);
  await approveSnapshot(services, {
    projectId: inspected.ready.projectId,
    submissionId: inspected.ready.submissionId,
    digest: inspected.digest,
    operation: "publish",
  });
  await publishSnapshot(services, {
    projectId: inspected.ready.projectId,
    submissionId: inspected.ready.submissionId,
    digest: inspected.digest,
  });
  return inspected;
}

test("widget containment does not depend on banning navigation syntax", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "amc-nav-"));
  const box = await writeClean(dir, { html: NAV });
  const inspected = await inspectSnapshot(dir);
  assert.equal(inspected.digest, box.digest);
  const services = createMemoryServices(env);
  await services.store.upsertProject(registration(box.projectId));
  await sealSnapshot(services, inspected);
  await approveSnapshot(services, { projectId: box.projectId, submissionId: box.submissionId, digest: box.digest, operation: "publish" });
  await publishSnapshot(services, { projectId: box.projectId, submissionId: box.submissionId, digest: box.digest });
  const wrapped = wrapWidgetDocument(NAV);
  assert.match(wrapped, /<base href="about:blank">/);
  assert.match(wrapped, /sandbox="allow-scripts allow-downloads"/);
  assert.equal(wrapped.includes("allow-same-origin"), false);
  assert.equal(wrapped.includes(box.projectId), false);
  const opened = await handle(new Request("http://127.0.0.1/api/access", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.70" },
    body: JSON.stringify({ code: "camp gate 2026" }),
  }), { services, env });
  assert.equal(opened.status, 401);
  const { importAccessFile } = await import("../lib/access-codes.js");
  await importAccessFile(services, { projectId: box.projectId, codes: [{ code: "camp gate 2026", expiresOn: "2027-06-01" }] }, Date.parse("2026-11-09T00:00:00Z"));
  const session = await handle(new Request("http://127.0.0.1/api/access", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.71" },
    body: JSON.stringify({ code: "camp gate 2026" }),
  }), { services, env });
  const cookie = /amc_session=([^;]*)/.exec(session.headers.get("set-cookie"))[1];
  const asDocument = await handle(new Request(`http://127.0.0.1/api/projects/${box.projectId}/widgets/viewer`, {
    headers: { cookie: `amc_session=${cookie}`, "sec-fetch-dest": "iframe", "sec-fetch-site": "same-origin" },
  }), { services, env });
  assert.equal(asDocument.status, 404);
  const fetched = await handle(new Request(`http://127.0.0.1/api/projects/${box.projectId}/widgets/viewer`, {
    headers: { cookie: `amc_session=${cookie}`, "sec-fetch-dest": "empty", "sec-fetch-mode": "cors", "sec-fetch-site": "same-origin" },
  }), { services, env });
  assert.equal(fetched.status, 200);
  const body = await fetched.text();
  assert.match(body, /about:blank/);
  assert.equal(body.includes(box.projectId), false);
});

test("publish serves one snapshot and ignores stale or failed media writes", async () => {
  const firstDir = await mkdtemp(path.join(tmpdir(), "amc-a-"));
  const secondDir = await mkdtemp(path.join(tmpdir(), "amc-b-"));
  const first = await writeClean(firstDir, { submissionId: "sub_example_010" });
  const second = await writeClean(secondDir, { submissionId: "sub_example_011", html: CLEAN.replace("Contained view", "Second view") });
  const services = createMemoryServices(env);
  await services.store.upsertProject(registration(first.projectId));
  await services.media.put(mediaPath(first.projectId, "extra"), PNG, "image/png");
  await services.store.putMedia({
    projectId: first.projectId,
    mediaId: "extra",
    pathname: mediaPath(first.projectId, "extra"),
    contentType: "image/png",
    filename: "extra.png",
    byteLength: PNG.length,
  });
  const published = await publishClean(services, firstDir);
  services.store.putMedia = async () => {
    throw new Error("injected media failure");
  };
  const secondInspected = await inspectSnapshot(secondDir);
  await sealSnapshot(services, secondInspected);
  await approveSnapshot(services, { projectId: second.projectId, submissionId: second.submissionId, digest: second.digest, operation: "publish" });
  await publishSnapshot(services, { projectId: second.projectId, submissionId: second.submissionId, digest: second.digest });
  const project = await services.store.getProject(first.projectId);
  assert.equal(project.title, "Title sub_example_011");
  assert.equal(project.summary.includes("Synthetic"), true);
  const { importAccessFile } = await import("../lib/access-codes.js");
  await importAccessFile(services, { projectId: first.projectId, codes: [{ code: "camp gate 2026", expiresOn: "2027-06-01" }] }, Date.parse("2026-11-09T00:00:00Z"));
  const session = await handle(new Request("http://127.0.0.1/api/access", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.72" },
    body: JSON.stringify({ code: "camp gate 2026" }),
  }), { services, env });
  const cookie = `amc_session=${/amc_session=([^;]*)/.exec(session.headers.get("set-cookie"))[1]}`;
  const stale = await handle(new Request(`http://127.0.0.1/api/projects/${first.projectId}/media/extra`, { headers: { cookie } }), { services, env });
  assert.equal(stale.status, 404);
  const photo = await handle(new Request(`http://127.0.0.1/api/projects/${first.projectId}/media/photo`, { headers: { cookie } }), { services, env });
  assert.equal(photo.status, 200);
  assert.equal(published.digest === second.digest, false);
  const results = await Promise.allSettled([
    publishSnapshot(services, { projectId: first.projectId, submissionId: first.submissionId, digest: first.digest }),
    publishSnapshot(services, { projectId: second.projectId, submissionId: second.submissionId, digest: second.digest }),
  ]);
  assert.equal(results.filter((item) => item.status === "fulfilled").length >= 1, true);
  const current = await services.store.getPublication(first.projectId);
  const served = await services.store.getProject(first.projectId);
  assert.equal(served.title, `Title ${current.submissionId}`);
});

test("registration and put-project do not replace a published presentation", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "amc-reg-"));
  const box = await writeClean(dir);
  const services = createMemoryServices(env);
  await services.store.upsertProject(registration(box.projectId, "Synthetic project"));
  await publishClean(services, dir);
  await assert.rejects(services.store.upsertProject(registration(box.projectId, "Clobbered title")), /unchanged/);
  const project = await services.store.getProject(box.projectId);
  assert.equal(project.title, `Title ${box.submissionId}`);
  const state = path.join(dir, "state.json");
  const data = services.store.dump();
  data.files = services.media.dump();
  data.sessions = [];
  await writeFile(state, JSON.stringify(data));
  const io = { stdout: { write(text) { this.text = `${this.text || ""}${text}`; } }, stderr: { write(text) { this.text = `${this.text || ""}${text}`; } } };
  assert.equal(await main(["register-project", "--store", "memory", "--state", state, "--project", box.projectId, "--title", "Clobbered title"], env, io), 0);
  assert.match(io.stdout.text, /left unchanged/);
  const replaced = path.join(dir, "replacement.json");
  await writeFile(replaced, JSON.stringify(registration(box.projectId, "Clobbered title")));
  assert.equal(await main(["put-project", "--store", "memory", "--state", state, "--file", replaced], env, io), 1);
  assert.match(io.stderr.text, /unchanged/);
});

test("dae references are exact and oversized text is refused before buffering", async () => {
  const files = new Map([["assets/model-a.dae", {}], ["assets/img-01.png", {}]]);
  assert.equal(exactAssetReference("assets/model-a.dae", "e", files), false);
  assert.equal(exactAssetReference("assets/model-a.dae", "assets/img-01.png", files), true);
  assert.match(colladaProblems(Buffer.from("<COLLADA><init_from><![CDATA[https://example.com/texture.png]]></init_from></COLLADA>"))[0], /doctype|entity|cdata|external/i);
  assert.match(colladaProblems(Buffer.from('<COLLADA><init_from href="https://example.com/texture.png"></init_from></COLLADA>'))[0], /external dae/);
  const bad = await mkdtemp(path.join(tmpdir(), "amc-dae-"));
  await assert.rejects(writeClean(bad, { dae: "<COLLADA><init_from>e</init_from></COLLADA>" }).then((box) => inspectSnapshot(bad).then(() => box)), /init_from/);
  const huge = await mkdtemp(path.join(tmpdir(), "amc-huge-"));
  await mkdir(path.join(huge, "assets"));
  const html = await open(path.join(huge, "assets/viewer.html"), "w");
  await html.truncate(MAX_MEDIA_BYTES + 1);
  await html.close();
  const dae = await open(path.join(huge, "assets/model-a.dae"), "w");
  await dae.truncate(MAX_MEDIA_BYTES + 1);
  await dae.close();
  const document = {
    projectId: "proj_example_001",
    submissionId: "sub_example_010",
    title: "Synthetic project",
    client: "Synthetic client",
    location: "Synthetic place",
    preparedBy: "Synthetic author",
    date: "2026-01-01",
    notesForReviewers: "Synthetic reviewer note.",
    content: { summary: "Synthetic summary for a private viewing test.", sections: [{ id: "overview", heading: "Overview", body: "Synthetic section body." }] },
    assets: [
      { path: "assets/viewer.html", role: "interactive-3d-viewer", note: "viewer" },
      { path: "assets/model-a.dae", role: "downloadable-3d-model", note: "model" },
    ],
  };
  const content = Buffer.from(`${JSON.stringify(document)}\n`);
  await writeFile(path.join(huge, "content.json"), content);
  await writeFile(path.join(huge, "READY.json"), JSON.stringify({
    projectId: "proj_example_001",
    submissionId: "sub_example_010",
    files: [
      { path: "assets/viewer.html", size: 1, sha256: "ab".repeat(32) },
      { path: "content.json", size: content.length, sha256: "ab".repeat(32) },
      { path: "assets/model-a.dae", size: 1, sha256: "cd".repeat(32) },
    ],
  }));
  await assert.rejects(inspectSnapshot(huge), /too large/);
});

test("derive refuses symlinks and any script other than the approved unused one", async () => {
  const source = await mkdtemp(path.join(tmpdir(), "amc-strip-"));
  const html = `${CLEAN.replace("</head>", `<script src="https://www.gstatic.com/antigravity/web/dev/tailwindcss.min.js"></script><script src="https://cdn.example.com/app.js"></script></head>`)}`;
  await writeClean(source, { html });
  const before = await readFile(path.join(source, "assets/viewer.html"), "utf8");
  const linked = path.join(tmpdir(), `amc-link-${Date.now()}`);
  await symlink(source, linked);
  await assert.rejects(deriveStrippedSnapshot(source, linked, "sub_example_099"), /output directory/);
  assert.equal(await readFile(path.join(source, "assets/viewer.html"), "utf8"), before);
  const plain = await mkdtemp(path.join(tmpdir(), "amc-plain-"));
  await assert.rejects(deriveStrippedSnapshot(source, plain, "sub_example_099"), /external/);
  assert.equal(await readFile(path.join(source, "assets/viewer.html"), "utf8"), before);
  assert.equal(before.includes("app.js"), true);
});

test("seal stores a snapshot in one transaction or not at all", async () => {
  const calls = [];
  const committed = [];
  function sql(strings, ...values) {
    const text = strings.join("?");
    if (text.includes("SELECT")) return [];
    return { text, values };
  }
  sql.transaction = async (queries) => {
    calls.push(queries.map((query) => query.text));
    const staged = [];
    for (const query of queries) {
      if (query.text.includes("submission_files") && staged.some((item) => item.text.includes("submission_files"))) {
        throw new Error("second file failed");
      }
      staged.push(query);
    }
    committed.push(...staged);
  };
  const store = createPostgresStore(sql);
  const record = {
    projectId: "proj_example_001",
    submissionId: "sub_example_010",
    digest: "ab".repeat(32),
    presentation: registration("proj_example_001"),
    files: [
      { path: "assets/a.png", sha256: "cd".repeat(32), size: 1, mediaId: "a", contentType: "image/png", filename: "a.png" },
      { path: "assets/b.png", sha256: "ef".repeat(32), size: 1, mediaId: "b", contentType: "image/png", filename: "b.png" },
    ],
  };
  await assert.rejects(store.sealSnapshot(record), (err) => {
    assert.equal(String(err.message).includes("second file"), false);
    return true;
  });
  assert.equal(calls.length, 1);
  assert.equal(committed.length, 0);
});

test("preview credentials cannot open maintenance or hosted access", async () => {
  const io = { stdout: { write() {} }, stderr: { write(text) { this.text = `${this.text || ""}${text}`; } } };
  const code = await main(["list", "--store", "remote", "--project", "proj_example_001"], {
    AMC_TARGET: "production",
    VERCEL_ENV: "preview",
    DATABASE_URL: "postgres://preview:secret@db/prod",
    CODE_PEPPER: PEPPER,
    BLOB_READ_WRITE_TOKEN: "preview-token",
    BLOB_STORE_ID: "store_preview",
    BLOB_PRIVATE_CANARY_SHA256: "ab".repeat(32),
  }, io);
  assert.equal(code, 1);
  assert.match(io.stderr.text, /Preview cannot/);
  assert.equal(io.stderr.text.includes("secret"), false);
  const preview = await handle(new Request("http://127.0.0.1/api/access", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: "camp gate 2026" }),
  }), {
    env: {
      VERCEL: "1",
      VERCEL_ENV: "preview",
      DATA_STORE: "postgres",
      MEDIA_STORE: "blob",
      DATABASE_URL: "postgres://preview:secret@db/prod",
      CODE_PEPPER: PEPPER,
      BLOB_STORE_ID: "store_preview",
      BLOB_READ_WRITE_TOKEN: "preview-token",
      BLOB_PRIVATE_CANARY_SHA256: "ab".repeat(32),
    },
    log() {},
  });
  assert.equal(preview.status, 503);
  assert.equal((await preview.text()).includes("secret"), false);
  const example = await readFile(new URL("../.env.example", import.meta.url), "utf8");
  assert.equal(/^\s*AMC_TARGET\s*=\s*production/m.test(example), false);
  const view = await readFile(new URL("../view.html", import.meta.url), "utf8");
  assert.match(view, /minlength="6"/);
  assert.equal(view.includes('minlength="20"'), false);
  const runbook = await readFile(new URL("../docs/runbook.md", import.meta.url), "utf8");
  assert.equal(runbook.includes("seed-demo --store remote"), false);
});

test("schema error type stays local", () => {
  assert.equal(new SchemaError("published project is unchanged").message, "published project is unchanged");
});
