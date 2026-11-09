import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { importAccessFile, revokeAccessCode, rotateAccessCode } from "../lib/access-codes.js";
import { main } from "../lib/cli.js";
import { colladaProblems, widgetProblems } from "../lib/content-policy.js";
import { TEST_FIXTURE_CODE, seedDemo } from "../lib/demo-fixture.js";
import {
  approveSnapshot,
  canonicalDigest,
  deriveStrippedSnapshot,
  inspectSnapshot,
  publishSnapshot,
  rollbackSnapshot,
  sealSnapshot,
} from "../lib/ingest.js";
import { SCHEMA } from "../lib/postgres-store.js";
import { handle } from "../lib/router.js";
import { createMemoryServices } from "../lib/runtime.js";
import { SchemaError } from "../lib/errors.js";

const PEPPER = "test-pepper-not-secret-32chars!!";
const env = { RATE_LIMIT_MAX: "8", RATE_LIMIT_WINDOW_MS: "600000" };
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082",
  "hex",
);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const PDF = Buffer.from("%PDF-1.1\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
const DAE = `<?xml version="1.0" encoding="utf-8"?>
<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">
  <asset><contributor><authoring_tool>fixture</authoring_tool></contributor></asset>
  <init_from>assets/img-01.png</init_from>
</COLLADA>
`;
const HTML = `<!doctype html><html><head>
<script src="https://www.gstatic.com/antigravity/web/dev/tailwindcss.min.js"></script>
<style>body{margin:0;color:#111}</style>
</head><body><canvas id="c"></canvas>
<script>document.getElementById("c").getContext("2d");</script>
</body></html>`;

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function registration(id) {
  return {
    id,
    title: "Synthetic project",
    summary: "Registered for private viewing. No submission is published yet.",
    fictional: false,
    sections: [{
      id: "pending",
      title: "Pending",
      blocks: [{ type: "text", text: "This project is registered and has no published submission." }],
    }],
    attachments: [],
  };
}

async function writeBox(dir, html) {
  const projectId = "proj_example_001";
  const submissionId = "sub_example_001";
  const assets = [
    ["assets/viewer.html", Buffer.from(html), "interactive-3d-viewer"],
    ["assets/model-a.dae", Buffer.from(DAE), "downloadable-3d-model"],
    ["assets/model-b.dae", Buffer.from(DAE.replace("<init_from>assets/img-01.png</init_from>", "")), "downloadable-3d-model"],
  ];
  for (let index = 1; index <= 4; index += 1) assets.push([`assets/doc-${index}.pdf`, PDF, "downloadable-pdf"]);
  for (let index = 1; index <= 21; index += 1) {
    assets.push([`assets/img-${String(index).padStart(2, "0")}.png`, PNG, "gallery"]);
  }
  assets.push(["assets/img-22.jpg", JPEG, "hero"]);
  assets.push(["assets/img-23.jpg", JPEG, "reference-photo"]);
  const document = {
    projectId,
    submissionId,
    title: "Synthetic project",
    client: "Synthetic client",
    location: "Synthetic place",
    preparedBy: "Synthetic author",
    date: "2026-01-01",
    notesForReviewers: "Synthetic reviewer note.",
    content: { summary: "Synthetic summary for a private viewing test.", sections: [{ id: "overview", heading: "Overview", body: "Synthetic section body." }] },
    assets: assets.map(([assetPath, , role]) => ({ path: assetPath, role, note: role })),
  };
  const files = [{ path: "content.json", bytes: Buffer.from(`${JSON.stringify(document, null, 2)}\n`) }];
  for (const [assetPath, bytes] of assets) files.push({ path: assetPath, bytes });
  for (const file of files) {
    await mkdir(path.dirname(path.join(dir, file.path)), { recursive: true });
    await writeFile(path.join(dir, file.path), file.bytes);
  }
  const listed = files.map((file) => ({ path: file.path, size: file.bytes.length, sha256: sha256(file.bytes) }));
  const digest = canonicalDigest(projectId, submissionId, listed);
  const ready = `${JSON.stringify({ projectId, submissionId, digest, files: listed }, null, 2)}\n`;
  await writeFile(path.join(dir, "READY.json"), ready);
  return { projectId, submissionId, digest, ready };
}

test("a 31-file submission keeps every asset and rejects the external script", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "amc-box-"));
  const box = await writeBox(dir, HTML);
  const inspected = await inspectSnapshot(dir);
  assert.equal(inspected.listed.size, 31);
  assert.equal(inspected.mapped.assets.length, 30);
  assert.equal(inspected.digest, box.digest);
  assert.equal(inspected.manifestDigestMatches, true);
  const roles = {};
  for (const asset of inspected.mapped.assets) roles[asset.role] = [...(roles[asset.role] || []), asset];
  assert.equal(roles["interactive-3d-viewer"].length, 1);
  assert.equal(roles["downloadable-3d-model"].length, 2);
  assert.equal(roles["downloadable-pdf"].length, 4);
  assert.equal(roles.gallery.length, 21);
  assert.equal(roles.hero.length, 1);
  assert.equal(roles["reference-photo"].length, 1);
  assert.equal(inspected.mapped.presentation.fictional, false);
  assert.equal(inspected.mapped.presentation.sections.some((section) => section.id === "overview"), true);
  assert.equal(widgetProblems(Buffer.from(HTML)).some((problem) => problem.startsWith("external script")), false);
  const foreign = HTML.replace("https://www.gstatic.com/antigravity/web/dev/tailwindcss.min.js", "https://cdn.example/app.js");
  assert.match(widgetProblems(Buffer.from(foreign))[0], /external script src:/);
  assert.match(colladaProblems(Buffer.from("<!DOCTYPE collada [<!ENTITY x SYSTEM 'file:///secret'>]><COLLADA></COLLADA>"))[0], /doctype|entity/i);
  assert.match(colladaProblems(Buffer.from("<COLLADA><init_from>https://example.com/a.png</init_from></COLLADA>"))[0], /external dae/);
});

test("derive strips only the unused script and records both digests", async () => {
  const source = await mkdtemp(path.join(tmpdir(), "amc-src-"));
  const output = await mkdtemp(path.join(tmpdir(), "amc-out-"));
  const box = await writeBox(source, HTML);
  const derived = await deriveStrippedSnapshot(source, output, "sub_example_002");
  assert.equal(derived.published, false);
  assert.equal(derived.inputDigest, box.digest);
  assert.notEqual(derived.outputDigest, box.digest);
  assert.equal(await readFile(path.join(source, "READY.json"), "utf8"), box.ready);
  assert.equal((await readFile(path.join(source, "assets/viewer.html"), "utf8")).includes("antigravity"), true);
  const stripped = await readFile(path.join(output, "assets/viewer.html"), "utf8");
  assert.equal(stripped.includes("antigravity"), false);
  assert.equal(stripped.includes("getContext"), true);
  const receipt = JSON.parse(await readFile(path.join(output, "DERIVED.json"), "utf8"));
  assert.equal(receipt.derivedFrom.snapshotDigest, box.digest);
  assert.equal(receipt.derivedFrom.manifestDigest, box.digest);
  assert.equal(receipt.outputDigest, derived.outputDigest);
  assert.equal(receipt.operation, "strip-unused-external-scripts");
  assert.equal(receipt.published, false);
  const inspected = await inspectSnapshot(output);
  assert.equal(inspected.digest, derived.outputDigest);
  assert.equal(inspected.manifestDigestMatches, true);
  assert.equal(inspected.ready.submissionId, "sub_example_002");
  assert.doesNotThrow(() => {
    for (const asset of inspected.mapped.assets) {
      if (asset.kind === "widget") assert.deepEqual(asset.problems, []);
    }
  });
});

test("publish requires the sealed digest and rollback leaves codes revoked", async () => {
  const source = await mkdtemp(path.join(tmpdir(), "amc-pub-"));
  const output = await mkdtemp(path.join(tmpdir(), "amc-pub-out-"));
  await writeBox(source, HTML);
  const derived = await deriveStrippedSnapshot(source, output, "sub_example_002");
  const services = createMemoryServices({ CODE_PEPPER: PEPPER });
  await services.store.upsertProject(registration("proj_example_001"));
  const inspected = await inspectSnapshot(output);
  const sealed = await sealSnapshot(services, inspected);
  assert.equal(sealed.published, false);
  await assert.rejects(publishSnapshot(services, {
    projectId: "proj_example_001",
    submissionId: "sub_example_002",
    digest: derived.outputDigest,
  }), /approval required/);
  await assert.rejects(approveSnapshot(services, {
    projectId: "proj_example_001",
    submissionId: "sub_example_002",
    digest: "a".repeat(64),
    operation: "publish",
  }), /does not match/);
  await approveSnapshot(services, {
    projectId: "proj_example_001",
    submissionId: "sub_example_002",
    digest: derived.outputDigest,
    operation: "publish",
  });
  const first = await publishSnapshot(services, {
    projectId: "proj_example_001",
    submissionId: "sub_example_002",
    digest: derived.outputDigest,
  });
  const second = await publishSnapshot(services, {
    projectId: "proj_example_001",
    submissionId: "sub_example_002",
    digest: derived.outputDigest,
  });
  assert.equal(second.idempotent, true);
  assert.equal(second.version, first.version);
  const published = await services.store.getProject("proj_example_001");
  assert.equal(published.sections.some((section) => section.blocks.some((block) => block.type === "widget")), true);

  const nextDir = await mkdtemp(path.join(tmpdir(), "amc-next-clean-"));
  await deriveStrippedSnapshot(source, nextDir, "sub_example_003");
  const next = await inspectSnapshot(nextDir);
  await sealSnapshot(services, next);
  await approveSnapshot(services, {
    projectId: "proj_example_001",
    submissionId: "sub_example_003",
    digest: next.digest,
    operation: "publish",
  });
  await publishSnapshot(services, {
    projectId: "proj_example_001",
    submissionId: "sub_example_003",
    digest: next.digest,
  });
  await importAccessFile(services, {
    projectId: "proj_example_001",
    codes: [{ code: "Camp Gate 2026", label: "synthetic", expiresOn: "2027-06-01" }],
  }, Date.parse("2026-11-09T00:00:00Z"));
  const opened = await handle(jsonRequest("Camp  Gate   2026"), { services, env });
  assert.equal(opened.status, 200);
  const cookie = cookieHeader(opened);
  await revokeAccessCode(services, "proj_example_001", "camp gate 2026");
  await approveSnapshot(services, {
    projectId: "proj_example_001",
    submissionId: "sub_example_002",
    digest: derived.outputDigest,
    operation: "rollback",
  });
  const rolled = await rollbackSnapshot(services, {
    projectId: "proj_example_001",
    submissionId: "sub_example_002",
    digest: derived.outputDigest,
  });
  assert.equal(rolled.codesChanged, false);
  const after = await handle(new Request("http://127.0.0.1/api/projects/proj_example_001/presentation", { headers: { cookie } }), { services, env });
  assert.equal(after.status, 401);
  const code = await services.store.getCodeByHash(
    (await import("../lib/codes.js")).lookupHash("camp gate 2026", PEPPER),
  );
  assert.ok(code.revokedAt);
});

test("custom codes are idempotent, project-scoped, and revocable", async () => {
  const services = createMemoryServices({ CODE_PEPPER: PEPPER });
  await services.store.upsertProject(registration("proj_example_001"));
  await services.store.upsertProject(registration("proj_example_002"));
  const file = {
    projectId: "proj_example_001",
    codes: [{ code: "Camp Gate 2026", label: "synthetic", expiresOn: "2027-06-01" }],
  };
  const now = Date.parse("2026-11-09T00:00:00Z");
  await importAccessFile(services, file, now);
  const opened = await handle(jsonRequest("camp gate 2026"), { services, env });
  assert.equal(opened.status, 200);
  const cookie = cookieHeader(opened);
  const again = await importAccessFile(services, file, now);
  assert.equal(again.results[0].status, "unchanged");
  const still = await handle(new Request("http://127.0.0.1/api/projects/proj_example_001/presentation", { headers: { cookie } }), { services, env });
  assert.equal(still.status, 200);
  await assert.rejects(
    importAccessFile(services, { projectId: "proj_example_002", codes: [{ code: "camp gate 2026", label: "other" }] }, now),
    /another project/,
  );
  const firstStill = await handle(new Request("http://127.0.0.1/api/projects/proj_example_001/presentation", { headers: { cookie } }), { services, env });
  assert.equal(firstStill.status, 200);
  await importAccessFile(services, { projectId: "proj_example_002", codes: [{ code: "other gate 2026", label: "other", expiresOn: "2027-06-01" }] }, now);
  await assert.rejects(rotateAccessCode(services, "proj_example_001", "camp gate 2026", "other gate 2026"), /another project/);
  const notRotated = await handle(new Request("http://127.0.0.1/api/projects/proj_example_001/presentation", { headers: { cookie } }), { services, env });
  assert.equal(notRotated.status, 200);
  await rotateAccessCode(services, "proj_example_001", "Camp Gate 2026", "fresh gate 2026", { expiresOn: "2027-06-01" });
  const oldSession = await handle(new Request("http://127.0.0.1/api/projects/proj_example_001/presentation", { headers: { cookie } }), { services, env });
  assert.equal(oldSession.status, 401);
  const fresh = await handle(jsonRequest("Fresh Gate 2026"), { services, env });
  assert.equal(fresh.status, 200);
  assert.equal(JSON.stringify(await fresh.json()).includes("fresh gate"), false);
  const leaked = await handle(jsonRequest("fresh gate 2026", { query: "?code=fresh%20gate%202026" }), { services, env });
  assert.equal(leaked.status, 400);
  await assert.rejects(importAccessFile(services, {
    projectId: "proj_example_001",
    codes: [{ code: "replace-with-a-code", label: "nope" }],
  }, now), /not usable/);
});

test("widgets stay in a script sandbox and dae files download", async () => {
  const services = createMemoryServices({ CODE_PEPPER: PEPPER });
  await seedDemo(services);
  const opened = await handle(jsonRequest(TEST_FIXTURE_CODE), { services, env });
  const cookie = cookieHeader(opened);
  const openedWidget = await handle(new Request("http://127.0.0.1/api/projects/demo-northglass/widgets/sketch/open", { headers: { cookie } }), { services, env });
  assert.equal(openedWidget.status, 200);
  assert.match(openedWidget.headers.get("content-security-policy"), /connect-src 'none'/);
  assert.equal(openedWidget.headers.get("content-security-policy").includes("allow-same-origin"), false);
  const embedded = await handle(new Request("http://127.0.0.1/api/projects/demo-northglass/widgets/sketch", { headers: { cookie } }), { services, env });
  assert.equal(embedded.status, 404);
  const asMedia = await handle(new Request("http://127.0.0.1/api/projects/demo-northglass/media/sketch", { headers: { cookie } }), { services, env });
  assert.equal(asMedia.status, 404);
  const dae = await handle(new Request("http://127.0.0.1/api/projects/demo-northglass/attachments/model", { headers: { cookie } }), { services, env });
  assert.equal(dae.status, 200);
  assert.equal(dae.headers.get("content-type"), "model/vnd.collada+xml");
  assert.match(dae.headers.get("content-disposition"), /^attachment;/);
  assert.equal(dae.headers.get("x-content-type-options"), "nosniff");
  const other = await handle(new Request("http://127.0.0.1/api/projects/proj_example_002/widgets/sketch/open", { headers: { cookie } }), { services, env });
  assert.equal(other.status, 404);
  const source = await readFile(new URL("../js/view.js", import.meta.url), "utf8");
  assert.match(source, /Open 3D Kitchen Studio/);
  assert.match(source, /\/widgets\/\$\{block\.mediaId\}\/open/);
  assert.equal(source.includes("srcdoc"), false);
  assert.equal(source.includes("iframe"), false);
  assert.equal(source.includes("postMessage"), false);
});

test("reviewed sql matches the store and the repo has no client submission", async () => {
  const sql = await readFile(new URL("../db/schema.sql", import.meta.url), "utf8");
  for (const statement of SCHEMA) assert.equal(sql.includes(statement), true);
  const needles = ["antigravity", "proj_buckner", "sub_20261108", "6e093f9c"];
  const roots = ["lib", "fixtures", "templates", "docs", "db", "js", "css", "api", "assets"];
  for (const root of roots) {
    const files = await walk(path.join(path.resolve("."), root));
    for (const file of files) {
      const text = await readFile(file, "utf8");
      for (const needle of needles) {
        if (needle === "antigravity" && file.endsWith(`${path.sep}lib${path.sep}content-policy.js`)) continue;
        assert.equal(text.includes(needle), false, `${file} contains ${needle}`);
      }
    }
  }
});

test("remote maintenance refuses a preview pepper target", async () => {
  const io = { stdout: { write() {} }, stderr: { write(text) { this.text = `${this.text || ""}${text}`; } } };
  const code = await main(["list", "--project", "proj_example_001"], { AMC_TARGET: "preview", CODE_PEPPER: PEPPER }, io);
  assert.equal(code, 1);
  assert.match(io.stderr.text, /production/);
  assert.match(io.stderr.text, /production credentials/);
  const seeded = await main(["seed-demo", "--store", "memory"], { AMC_TARGET: "production", CODE_PEPPER: PEPPER, VERCEL_ENV: "" }, io);
  assert.equal(seeded, 2);
});

function jsonRequest(code, { query = "", ip = "203.0.113.80" } = {}) {
  return new Request(`http://127.0.0.1/api/access${query}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify({ code }),
  });
}

function cookieHeader(response) {
  const match = /amc_session=([^;]*)/.exec(response.headers.get("set-cookie") || "");
  return match && match[1] ? `amc_session=${match[1]}` : "";
}

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else if (/\.(js|mjs|json|md|css|html|sql|svg|txt)$/.test(entry.name)) files.push(full);
  }
  return files;
}

test("placeholder access file is rejected", async () => {
  const services = createMemoryServices({ CODE_PEPPER: PEPPER });
  await services.store.upsertProject(registration("example-project"));
  const document = JSON.parse(await readFile(new URL("../templates/project-access.json", import.meta.url), "utf8"));
  await assert.rejects(importAccessFile(services, document), (err) => err instanceof SchemaError && /not usable/.test(err.message));
});
