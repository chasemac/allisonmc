import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { main } from "../lib/cli.js";
import { PAGE_PREVIEW_BESIDE_DOCUMENTS, mapSubmission } from "../lib/content-policy.js";
import { assertPublishable, canonicalDigest, inspectSnapshot } from "../lib/ingest.js";

const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082",
  "hex",
);

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function image(name) {
  return { kind: "image", filename: name, bytes: PNG, contentType: "image/png" };
}

function pagePreviewDocument() {
  return JSON.parse(readFileSync("fixtures/page-preview/content.json", "utf8"));
}

function syntheticDocument(extra = {}) {
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
      sections: [{ id: "overview", heading: "Overview", body: "Synthetic section body." }],
    },
    assets: [],
    ...extra,
  };
}

async function stage(document, files) {
  const dir = await mkdtemp(path.join(tmpdir(), "amc-pages-"));
  const entries = [["content.json", Buffer.from(`${JSON.stringify(document)}\n`)]];
  for (const [filePath, bytes] of files) entries.push([filePath, bytes]);
  for (const [filePath, bytes] of entries) {
    await mkdir(path.dirname(path.join(dir, filePath)), { recursive: true });
    await writeFile(path.join(dir, filePath), bytes);
  }
  const listed = entries.map(([filePath, bytes]) => ({ path: filePath, size: bytes.length, sha256: sha256(bytes) }));
  const ready = {
    projectId: document.projectId,
    submissionId: document.submissionId,
    files: listed,
    digest: canonicalDigest(document.projectId, document.submissionId, listed),
  };
  await writeFile(path.join(dir, "READY.json"), `${JSON.stringify(ready)}\n`);
  return dir;
}

function capture() {
  const stdout = { text: "", write(chunk) { this.text += chunk; } };
  const stderr = { text: "", write(chunk) { this.text += chunk; } };
  return { stdout, stderr, io: { stdout, stderr } };
}

async function inspectCli(dir) {
  const { stdout, stderr, io } = capture();
  const code = await main(["inspect", "--dir", dir], { AMC_ENV_FILE: path.join(dir, "missing.env") }, io);
  return { code, stdout: stdout.text, stderr: stderr.text };
}

function assetRows(text) {
  const lines = text.split("\n");
  const start = lines.indexOf("assets:");
  assert.notEqual(start, -1);
  return lines.slice(start + 2).filter(Boolean).map((line) => {
    const [filePath, role, size, hash, problems] = line.split("\t");
    return { filePath, role, size, hash, problems };
  });
}

test("a page-preview fixture with no documents maps to the checked-in sections", () => {
  const document = pagePreviewDocument();
  assert.equal(Object.hasOwn(document.content, "documents"), false);
  assert.equal(document.assets.length, 7);
  assert.equal(document.assets.every((asset) => asset.role === "page-preview"), true);
  assert.equal(JSON.stringify(document).includes("replace-with-a-code"), false);
  const files = new Map(document.assets.map((asset) => [asset.path, image(path.basename(asset.path))]));
  const mapped = mapSubmission(document, files);
  const expected = JSON.parse(readFileSync("fixtures/page-preview/sections.json", "utf8"));
  assert.deepEqual(mapped.presentation.sections, expected);
  assert.deepEqual(mapped.warnings, []);
  assert.equal(mapped.presentation.fictional, false);
  assert.equal(mapped.assets.every((asset) => asset.problems === undefined), true);
  assert.equal(mapped.presentation.sections.some((section) => section.blocks.some((block) => block.type === "flow")), false);
});

test("inspect stays publishable for page previews and warns when documents are also present", async () => {
  const plain = pagePreviewDocument();
  const plainDir = await stage(plain, plain.assets.map((asset) => [asset.path, PNG]));
  const plainReceipt = await inspectCli(plainDir);
  assert.equal(plainReceipt.code, 0);
  assert.equal(plainReceipt.stderr, "");
  assert.match(plainReceipt.stdout, /^publishable: yes$/m);
  assert.equal(plainReceipt.stdout.includes("\nwarning:"), false);
  assert.equal(plainReceipt.stdout.includes("\nproblem:"), false);
  const plainRows = assetRows(plainReceipt.stdout);
  assert.equal(plainRows.length, 7);
  assert.equal(plainRows.every((row) => row.role === "page-preview" && row.problems === "none"), true);
  const plainInspected = await inspectSnapshot(plainDir);
  assert.doesNotThrow(() => assertPublishable(plainInspected));

  const mixed = syntheticDocument({
    assets: [{ path: "assets/page-01.png", role: "page-preview", note: "Synthetic flat page" }],
    content: {
      summary: "Synthetic summary for a private viewing test.",
      sections: [{ id: "overview", heading: "Overview", body: "Synthetic section body." }],
      documents: [{
        id: "concept-p1",
        heading: "Synthetic concept page",
        blocks: [{ type: "paragraph", text: "East side open." }],
      }],
    },
  });
  const mixedDir = await stage(mixed, [["assets/page-01.png", PNG]]);
  const mixedReceipt = await inspectCli(mixedDir);
  assert.equal(mixedReceipt.code, 0);
  assert.equal(mixedReceipt.stderr, "");
  assert.match(mixedReceipt.stdout, /^publishable: yes$/m);
  assert.match(mixedReceipt.stdout, new RegExp(`^warning: ${PAGE_PREVIEW_BESIDE_DOCUMENTS.replace(/[.]/g, "\\.")}$`, "m"));
  assert.equal(mixedReceipt.stdout.includes("\nproblem:"), false);
  const mixedRows = assetRows(mixedReceipt.stdout);
  assert.equal(mixedRows.length, 1);
  assert.equal(mixedRows[0].problems, PAGE_PREVIEW_BESIDE_DOCUMENTS);
  assert.match(mixedRows[0].problems, /source-page/);
  const inspected = await inspectSnapshot(mixedDir);
  assertPublishable(inspected);
  assert.deepEqual(inspected.mapped.warnings, [PAGE_PREVIEW_BESIDE_DOCUMENTS]);
  const ids = inspected.mapped.presentation.sections.map((section) => section.id);
  assert.equal(ids.includes("concept-p1"), true);
  assert.equal(ids.includes("role-page-preview"), true);
});

test("inspect rejects an unknown flow-block key", async () => {
  const document = syntheticDocument({
    content: {
      summary: "Synthetic summary for a private viewing test.",
      sections: [{ id: "overview", heading: "Overview", body: "Synthetic section body." }],
      documents: [{
        id: "concept-p1",
        heading: "Synthetic concept page",
        blocks: [{ type: "paragraph", text: "East side open.", html: "<b>no</b>" }],
      }],
    },
  });
  const dir = await stage(document, []);
  const receipt = await inspectCli(dir);
  assert.equal(receipt.code, 1);
  assert.equal(receipt.stdout, "");
  assert.equal(receipt.stderr, "unexpected flow field\n");
  await assert.rejects(inspectSnapshot(dir), (err) => err instanceof Error && err.message === "unexpected flow field");
});
