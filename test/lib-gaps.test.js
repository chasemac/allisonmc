import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { expiryFromAccessEntry, importAccessFile, rotateAccessCode } from "../lib/access-codes.js";
import { MEDIA_ID, lookupHash, mediaPath, readId, snapshotMediaPath } from "../lib/codes.js";
import { classifyAsset, colladaProblems, mapSubmission, widgetProblems } from "../lib/content-policy.js";
import { FailClosed, SchemaError } from "../lib/errors.js";
import { clientIp, readCookie, readJsonObject } from "../lib/http.js";
import { inspectSnapshot } from "../lib/ingest.js";
import { detectMedia, safeFilename } from "../lib/media-types.js";
import { createMemoryStore } from "../lib/memory-store.js";
import { createPostgresStore } from "../lib/postgres-store.js";
import { redact } from "../lib/redact.js";
import { handle } from "../lib/router.js";
import { assertRuntimeConfig, blobConfigured, clearServiceCache, createMemoryServices, loadServices, rateConfig } from "../lib/runtime.js";
import { validatePresentation } from "../lib/schema.js";
import { publicRelativePath, readPublicFile } from "../lib/static-public.js";
import { TEST_FIXTURE_CODE, seedDemo } from "../lib/demo-fixture.js";

const PEPPER = "test-pepper-not-secret-32chars!!";
const env = { RATE_LIMIT_MAX: "8", RATE_LIMIT_WINDOW_MS: "600000" };
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082",
  "hex",
);
const NOW = Date.parse("2026-01-15T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function project(id = "proj_example_001") {
  return {
    id,
    title: "Synthetic project",
    summary: "Registered for a local test.",
    fictional: false,
    sections: [{ id: "overview", title: "Overview", blocks: [{ type: "text", text: "Synthetic section body." }] }],
    attachments: [],
  };
}

function submission(assets, sections) {
  return {
    projectId: "proj_example_001",
    submissionId: "sub_example_001",
    title: "Synthetic project",
    client: "Synthetic client",
    location: "Synthetic place",
    preparedBy: "Synthetic author",
    date: "2026-01-01",
    notesForReviewers: "Synthetic reviewer note.",
    content: {
      summary: "Synthetic summary for a private viewing test.",
      sections: sections || [{ id: "overview", heading: "Overview", body: "Synthetic section body." }],
    },
    assets,
  };
}

function accessRequest(code, ip = "203.0.113.60") {
  return new Request("http://127.0.0.1/api/access", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify({ code }),
  });
}

test("content checks reject the unsafe edges and ignore a commented collada reference", () => {
  assert.throws(() => classifyAsset("page.html", Buffer.from([0xff, 0xfe, 0x00])), /utf-8/);
  assert.deepEqual(colladaProblems(Buffer.from([0xff, 0xfe])), ["file is not utf-8 text"]);
  assert.deepEqual(widgetProblems(Buffer.from("<p>Hello</p>")), ["not a self-contained widget"]);
  const loose = "<!doctype html><html><head><script src=\"not a url\"></script><style>a{}</style></head><body></body></html>";
  assert.match(widgetProblems(Buffer.from(loose))[0], /external script src: not a url/);
  const userinfo = "<!doctype html><html><head><script src=\"https://user:pw@www.gstatic.com/app.js\"></script><style>a{}</style></head><body></body></html>";
  assert.match(widgetProblems(Buffer.from(userinfo))[0], /external script src:/);
  const allowed = "<!doctype html><html><head><script src=\"https://www.gstatic.com/app.js\"></script><style>a{}</style></head><body></body></html>";
  assert.match(widgetProblems(Buffer.from(allowed), { scriptSrcAllowlist: ["not a url"] })[0], /external script src:/);
  assert.deepEqual(colladaProblems(Buffer.from("<COLLADA><!-- <init_from>https://example.com/x.png</init_from> --><init_from>assets/photo.png</init_from></COLLADA>")), []);
  assert.match(colladaProblems(Buffer.from("<COLLADA><!--"))[0], /doctype or entity/);

  const files = new Map([["assets/photo.png", classifyAsset("photo.png", PNG)]]);
  assert.throws(() => mapSubmission(submission([{ path: "photo.png", role: "gallery", note: "photo" }]), files), /asset path/);
  assert.throws(() => mapSubmission(submission([{ path: "assets/photo.png", role: "interactive-3d-viewer", note: "viewer" }]), files), /role does not match/);
  assert.throws(() => mapSubmission(submission(
    [{ path: "assets/photo.png", role: "gallery", note: "photo" }],
    [
      { id: "overview", heading: "Overview", body: "One." },
      { id: "overview", heading: "Again", body: "Two." },
    ],
  ), files), /duplicate section/);
});

test("access codes default, reject, and leave a revoked code revoked", async () => {
  assert.equal(expiryFromAccessEntry({ expiresOn: "" }, NOW), NOW + 365 * DAY);
  assert.throws(() => expiryFromAccessEntry({ expiresOn: "2026/01/01" }, NOW), /YYYY-MM-DD/);
  assert.throws(() => expiryFromAccessEntry({ expiresOn: "2020-01-01" }, NOW), /past/);
  assert.throws(() => expiryFromAccessEntry({ expiresOn: "2030-01-01" }, NOW), /too far/);

  const services = createMemoryServices({ CODE_PEPPER: PEPPER });
  await services.store.upsertProject(project());
  await services.store.upsertProject(project("proj_example_002"));
  await assert.rejects(importAccessFile(services, { projectId: "proj_example_001", codes: [] }, NOW), /codes/);
  const imported = await importAccessFile(services, {
    projectId: "proj_example_001",
    codes: [{ code: "harbor lantern", label: "delivery" }],
  }, NOW);
  assert.equal(imported.results[0].status, "created");
  const hash = lookupHash("harbor lantern", PEPPER);
  assert.equal((await services.store.getCodeByHash(hash)).expiresAt, NOW + 365 * DAY);
  await services.store.revokeCode(imported.results[0].codeId);
  const again = await importAccessFile(services, {
    projectId: "proj_example_001",
    codes: [{ code: "harbor lantern", label: "delivery" }],
  }, NOW);
  assert.equal(again.results[0].status, "revoked");
  assert.ok((await services.store.getCodeByHash(hash)).revokedAt);
  await assert.rejects(
    rotateAccessCode(services, "proj_example_002", "harbor lantern", "river lantern", {}, NOW),
    /could not revoke that code for this project/,
  );
  await assert.rejects(
    rotateAccessCode(services, "proj_example_001", "missing lantern", "river lantern", {}, NOW),
    /could not revoke that code for this project/,
  );
});

test("memory store code, publish, and rate-window behavior matches the postgres row contract", async () => {
  const store = createMemoryStore();
  const presentation = project();
  await store.upsertProject(presentation);
  assert.equal(await store.getCodeById("missing"), null);
  assert.deepEqual(await store.listProjects(), [{ id: presentation.id, title: presentation.title, fictional: false }]);
  const expiresAt = Date.parse("2026-06-01T12:00:00.000Z");
  const hash = "ab".repeat(32);
  await store.insertCode({
    id: "code_1",
    lookupHash: hash,
    projectId: presentation.id,
    label: "delivery",
    expiresAt,
  });
  await store.updateCode("code_1", { label: "renamed", expiresAt: expiresAt + DAY });
  const updated = await store.getCodeById("code_1");
  updated.label = "mutated";
  assert.equal((await store.getCodeById("code_1")).label, "renamed");
  assert.equal((await store.getCodeById("code_1")).expiresAt, expiresAt + DAY);

  const digest = "b".repeat(64);
  await store.sealSnapshot({
    projectId: presentation.id,
    submissionId: "sub_example_001",
    digest,
    presentation,
    files: [],
  });
  assert.deepEqual(
    await store.compareAndSetPublication({ projectId: presentation.id, submissionId: "sub_example_001", digest, expectedVersion: 0 }),
    { version: 1, idempotent: false },
  );
  assert.deepEqual(
    await store.compareAndSetPublication({ projectId: presentation.id, submissionId: "sub_example_001", digest, expectedVersion: 99 }),
    { version: 1, idempotent: true },
  );
  await assert.rejects(
    () => store.compareAndSetPublication({
      projectId: presentation.id,
      submissionId: "sub_example_002",
      digest: "c".repeat(64),
      expectedVersion: 0,
    }),
    (err) => err instanceof FailClosed && /publish conflict/.test(err.message),
  );

  await store.revokeProjectCodes(presentation.id);
  const listed = await store.listCodes(presentation.id);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, "code_1");
  assert.ok(listed[0].revokedAt);
  assert.equal(Object.hasOwn(listed[0], "lookupHash"), false);

  const bucket = "access:203.0.113.50";
  const limit = { max: 2, windowMs: 60000 };
  assert.deepEqual(await store.consumeRateLimit(bucket, { ...limit, now: 120000 }), { allowed: true, count: 1 });
  assert.deepEqual(await store.consumeRateLimit(bucket, { ...limit, now: 179999 }), { allowed: true, count: 2 });
  assert.deepEqual(await store.consumeRateLimit(bucket, { ...limit, now: 179999 }), { allowed: false, count: 3 });
  assert.deepEqual(await store.consumeRateLimit(bucket, { ...limit, now: 180000 }), { allowed: true, count: 1 });

  const codeRow = {
    id: "code_1",
    lookup_hash: hash,
    project_id: presentation.id,
    label: "renamed",
    expires_at: new Date(expiresAt + DAY).toISOString(),
    revoked_at: null,
  };
  const postgres = createPostgresStore((strings) => {
    const text = strings.join("?");
    if (text.includes("FROM share_codes")) return [codeRow];
    if (text.includes("FROM media_objects")) {
      return [{
        project_id: presentation.id,
        media_id: "photo",
        pathname: "projects/proj_example_001/media/photo",
        content_type: "image/png",
        filename: "photo.png",
        byte_length: PNG.length,
      }];
    }
    if (text.includes("FROM publications")) {
      return [{ submission_id: "sub_example_001", digest: "a".repeat(64), version: 1 }];
    }
    if (text.includes("FROM submission_snapshots")) {
      return [{ digest: "b".repeat(64), presentation: {} }];
    }
    if (text.includes("RETURNING count") || text.includes("rate_limits")) return [{ count: 3 }];
    return [];
  });
  const pgCode = await postgres.getCodeByHash(hash);
  assert.equal(pgCode.expiresAt, expiresAt + DAY);
  assert.equal(pgCode.projectId, presentation.id);
  assert.equal(pgCode.revokedAt, null);
  assert.equal(Object.hasOwn(pgCode, "lookupHash"), true);
  const brokenStamp = await createPostgresStore(() => [{ ...codeRow, expires_at: "not-a-date", revoked_at: "also-not" }]).getCodeByHash(hash);
  assert.equal(brokenStamp.expiresAt, null);
  assert.equal(brokenStamp.revokedAt, null);
  await store.putMedia({
    projectId: presentation.id,
    mediaId: "photo",
    pathname: "projects/proj_example_001/media/photo",
    contentType: "image/png",
    filename: "photo.png",
    byteLength: PNG.length,
  });
  assert.deepEqual(await postgres.getMedia(presentation.id, "photo"), await store.getMedia(presentation.id, "photo"));
  assert.deepEqual(
    await postgres.consumeRateLimit(bucket, { max: 2, windowMs: 60000, now: 120000 }),
    { allowed: false, count: 3 },
  );
  await assert.rejects(
    () => createPostgresStore(() => []).consumeRateLimit(bucket, { max: 2, windowMs: 60000, now: 1 }),
    (err) => err instanceof FailClosed && err.message === "rate limit store unavailable",
  );
  await assert.rejects(
    () => createPostgresStore(() => [{ count: "nope" }]).consumeRateLimit(bucket, { max: 2, windowMs: 60000, now: 1 }),
    (err) => err instanceof FailClosed && err.message === "rate limit store unavailable",
  );
  await assert.rejects(
    () => postgres.getProject(presentation.id),
    (err) => err instanceof FailClosed && err.message === "published snapshot refused",
  );
  await store.importPublication({ projectId: presentation.id, submissionId: "sub_example_001", digest: "a".repeat(64), version: 1 });
  await store.importSnapshot({
    projectId: presentation.id,
    submissionId: "sub_example_001",
    digest: "d".repeat(64),
    presentation: {},
    files: [],
  });
  await assert.rejects(
    () => store.getProject(presentation.id),
    (err) => err instanceof FailClosed && err.message === "published snapshot refused",
  );
});

test("router failures stay closed when the store, project, or media path is unusable", async () => {
  const logs = [];
  const log = (message) => logs.push(String(message));
  const orphan = createMemoryServices({ CODE_PEPPER: PEPPER });
  await orphan.store.insertCode({
    id: "code_orphan",
    lookupHash: lookupHash("orphan-entry-code", PEPPER),
    projectId: "missing-project",
    label: "orphan",
    expiresAt: Date.now() + DAY,
  });
  const missing = await handle(accessRequest("orphan-entry-code", "203.0.113.61"), { services: orphan, env, log });
  assert.equal(missing.status, 401);
  assert.equal((await missing.json()).error, "That code is not valid.");
  assert.equal(logs.includes("access denied missing project"), true);

  const broken = createMemoryServices({ CODE_PEPPER: PEPPER });
  await seedDemo(broken);
  broken.store.getCodeByHash = async () => {
    throw new Error("postgres://user:secret@db.example/app");
  };
  const wrapped = await handle(accessRequest(TEST_FIXTURE_CODE, "203.0.113.62"), { services: broken, env, log });
  assert.equal(wrapped.status, 503);
  assert.equal((await wrapped.text()).includes("secret"), false);
  assert.equal(logs.join("\n").includes("secret"), false);
  broken.store.getCodeByHash = async () => {
    throw new FailClosed("project store unavailable");
  };
  const closed = await handle(accessRequest(TEST_FIXTURE_CODE, "203.0.113.63"), { services: broken, env, log });
  assert.equal(closed.status, 503);

  const services = createMemoryServices({ CODE_PEPPER: PEPPER });
  await seedDemo(services);
  const opened = await handle(accessRequest(TEST_FIXTURE_CODE, "203.0.113.64"), { services, env, log });
  assert.equal(opened.status, 200);
  const cookie = opened.headers.get("set-cookie");
  services.store.getSession = async () => {
    throw new Error("session db down");
  };
  const sessionDown = await handle(new Request("http://127.0.0.1/api/projects/demo-northglass/presentation", { headers: { cookie } }), { services, env, log });
  assert.equal(sessionDown.status, 503);
  assert.equal(logs.includes("session store unavailable"), true);

  const media = createMemoryServices({ CODE_PEPPER: PEPPER });
  await seedDemo(media);
  const mediaCookie = (await handle(accessRequest(TEST_FIXTURE_CODE, "203.0.113.65"), { services: media, env, log })).headers.get("set-cookie");
  await media.store.putMedia({
    projectId: "demo-northglass",
    mediaId: "plan",
    pathname: "projects/other-room/media/plan",
    contentType: "image/png",
    filename: "plan.png",
    byteLength: 8,
  });
  const refused = await handle(new Request("http://127.0.0.1/api/projects/demo-northglass/media/plan", { headers: { cookie: mediaCookie } }), { services: media, env, log });
  assert.equal(refused.status, 503);
  assert.equal(logs.includes("media path refused"), true);
  await media.store.putMedia({
    projectId: "demo-northglass",
    mediaId: "plan",
    pathname: mediaPath("demo-northglass", "plan"),
    contentType: "text/plain",
    filename: "plan.txt",
    byteLength: 4,
  });
  const typed = await handle(new Request("http://127.0.0.1/api/projects/demo-northglass/media/plan", { headers: { cookie: mediaCookie } }), { services: media, env, log });
  assert.equal(typed.status, 503);
  assert.equal(logs.includes("media type refused"), true);
  await media.store.putMedia({
    projectId: "demo-northglass",
    mediaId: "plan",
    pathname: mediaPath("demo-northglass", "plan"),
    contentType: "image/png",
    filename: "plan.png",
    byteLength: PNG.length,
  });
  media.media.get = async () => {
    throw new Error("blob token secret-blob");
  };
  const outage = await handle(new Request("http://127.0.0.1/api/projects/demo-northglass/media/plan", { headers: { cookie: mediaCookie } }), { services: media, env, log });
  assert.equal(outage.status, 503);
  assert.equal((await outage.text()).includes("secret-blob"), false);
  assert.equal(logs.includes("media store unavailable"), true);
});

test("small library edges reject bad ids, media, config, and public paths", async () => {
  assert.equal(redact("postgresql://user:secret@host/db BLOB_READ_WRITE_TOKEN=vercel_blob_rw_example CODE_PEPPER: pepper-value ordinary").includes("secret"), false);
  assert.equal(redact("BLOB_READ_WRITE_TOKEN=vercel_blob_rw_example").includes("vercel_blob"), false);
  assert.equal(redact("CODE_PEPPER: pepper-value").includes("pepper-value"), false);
  assert.equal(redact("ordinary title").includes("ordinary title"), true);

  assert.throws(() => mediaPath("Bad Id", "plan"), /media path refused/);
  assert.throws(() => snapshotMediaPath("proj_example_001", "nope", "plan"), /media path refused/);
  assert.equal(readId("%", MEDIA_ID), null);
  assert.equal(readId("%E0%A4%A", MEDIA_ID), null);
  assert.equal(readCookie("theme=dark", "amc_session"), "");
  assert.equal(readCookie("broken; amc_session=abc", "amc_session"), "abc");
  assert.equal(clientIp(new Request("http://127.0.0.1/", { headers: { "x-forwarded-for": "bad ip" } })), "unknown");
  assert.equal(await readJsonObject(new Request("http://127.0.0.1/", { method: "POST", body: "{" })), null);
  assert.equal(await readJsonObject(new Request("http://127.0.0.1/", { method: "POST", body: "[]" })), null);

  const wave = Buffer.alloc(16);
  wave.write("RIFF", 0);
  wave.write("WAVE", 8);
  assert.equal(detectMedia(wave), null);
  const webp = Buffer.alloc(16);
  webp.write("RIFF", 0);
  webp.write("WEBP", 8);
  assert.equal(detectMedia(webp).contentType, "image/webp");
  assert.equal(detectMedia(Buffer.alloc(0)), null);
  assert.equal(safeFilename("plan.png"), "plan.png");
  assert.equal(safeFilename("has space.png"), null);
  assert.equal(safeFilename(`${"a".repeat(81)}.png`), null);

  const canary = "ab".repeat(32);
  assert.equal(blobConfigured({ BLOB_PRIVATE_CANARY_SHA256: "zz", BLOB_READ_WRITE_TOKEN: "token" }), false);
  assert.equal(blobConfigured({ VERCEL: "1", BLOB_STORE_ID: "store_selected", BLOB_PRIVATE_CANARY_SHA256: canary }), true);
  assert.equal(blobConfigured({ VERCEL: "1", BLOB_PRIVATE_CANARY_SHA256: canary }), false);
  assert.equal(blobConfigured({
    BLOB_AUTH: "oidc",
    BLOB_STORE_ID: "store_selected",
    VERCEL_OIDC_TOKEN: "oidc-token",
    BLOB_PRIVATE_CANARY_SHA256: canary,
  }), true);
  assert.equal(blobConfigured({ BLOB_AUTH: "oidc", BLOB_STORE_ID: "store_selected", BLOB_PRIVATE_CANARY_SHA256: canary }), false);
  assert.deepEqual(rateConfig({}), { max: 8, windowMs: 600000, globalMax: 0 });
  assert.throws(() => rateConfig({ RATE_LIMIT_WINDOW_MS: "1000" }), (err) => err instanceof FailClosed);
  assert.throws(() => rateConfig({ RATE_LIMIT_MAX: "0" }), (err) => err instanceof FailClosed);
  assert.deepEqual(assertRuntimeConfig({ DATA_STORE: "memory", MEDIA_STORE: "memory", CODE_PEPPER: PEPPER }), { mode: "memory" });
  assert.throws(() => assertRuntimeConfig({
    VERCEL: "1",
    VERCEL_ENV: "production",
    DATA_STORE: "memory",
    MEDIA_STORE: "memory",
    CODE_PEPPER: PEPPER,
  }), /memory store refused/);
  assert.throws(() => assertRuntimeConfig({ DATA_STORE: "memory", MEDIA_STORE: "blob", CODE_PEPPER: PEPPER }), /memory store refused/);
  assert.throws(() => assertRuntimeConfig({ DATA_STORE: "sqlite", MEDIA_STORE: "blob" }), /unsupported store/);
  assert.throws(() => assertRuntimeConfig({
    NODE_ENV: "production",
    DATA_STORE: "sqlite",
    MEDIA_STORE: "blob",
    CODE_PEPPER: PEPPER,
  }), /stores not configured/);
  assert.throws(() => assertRuntimeConfig({ DATA_STORE: "postgres", MEDIA_STORE: "blob", CODE_PEPPER: PEPPER }), /database not configured/);
  assert.throws(() => assertRuntimeConfig({
    DATA_STORE: "postgres",
    MEDIA_STORE: "blob",
    DATABASE_URL: "postgres://example.invalid/db",
    CODE_PEPPER: PEPPER,
  }), /media store not configured/);
  clearServiceCache();
  const runtimeEnv = { DATA_STORE: "memory", MEDIA_STORE: "memory", CODE_PEPPER: PEPPER };
  const first = await loadServices(runtimeEnv);
  const second = await loadServices(runtimeEnv);
  assert.equal(first, second);
  clearServiceCache();
  assert.notEqual(await loadServices(runtimeEnv), first);

  assert.equal(publicRelativePath("/%"), null);
  assert.equal(publicRelativePath("/%E0%A4%A"), null);
  const page = await readPublicFile(process.cwd(), "/index.html");
  assert.equal(page.contentType, "text/html; charset=utf-8");
  assert.ok(page.bytes.length > 0);
  assert.equal(await readPublicFile(process.cwd(), "/assets/img/missing-file.png"), null);
  assert.equal(await readPublicFile(process.cwd(), "/lib/demo-fixture.js"), null);

  const base = project();
  assert.throws(() => validatePresentation({ ...base, sections: [] }), /sections/);
  assert.throws(() => validatePresentation({
    ...base,
    sections: Array.from({ length: 41 }, (_, index) => ({
      id: `s${index}`,
      title: "Section",
      blocks: [{ type: "text", text: "Body" }],
    })),
  }), /sections/);
  assert.throws(() => validatePresentation({
    ...base,
    sections: [{ id: "overview", title: "Overview", blocks: [] }],
  }), /blocks/);
  assert.throws(() => validatePresentation({
    ...base,
    attachments: [{ id: "file", label: "File", kind: "redirect" }],
  }), /attachment kind/);
  assert.throws(() => validatePresentation({
    ...base,
    sections: [{ id: "overview", title: "Overview", blocks: [{ type: "attachment", attachmentId: "missing" }] }],
  }), /unknown attachment/);
  assert.throws(() => validatePresentation({
    ...base,
    sections: [{ id: "overview", title: "Overview", blocks: [{ type: "gallery", images: [] }] }],
  }), /gallery/);
  assert.throws(() => validatePresentation({
    ...base,
    attachments: [{ id: "link", label: "Link", kind: "link", href: "not a url" }],
  }), /invalid link/);

  const dir = await mkdtemp(path.join(tmpdir(), "amc-inspect-"));
  await writeFile(path.join(dir, "READY.json"), JSON.stringify({
    projectId: "proj_example_001",
    submissionId: "sub_example_001",
    files: [{ path: "../secret", size: 1, sha256: "a".repeat(64) }],
  }));
  await assert.rejects(inspectSnapshot(dir), (err) => err instanceof SchemaError && /asset path/.test(err.message));
  await writeFile(path.join(dir, "READY.json"), JSON.stringify({
    projectId: "Not A Project",
    submissionId: "sub_example_001",
    files: [{ path: "content.json", size: 2, sha256: "a".repeat(64) }],
  }));
  await assert.rejects(inspectSnapshot(dir), /invalid submission id/);
});
