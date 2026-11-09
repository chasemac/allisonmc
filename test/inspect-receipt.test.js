import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { main } from "../lib/cli.js";
import { canonicalDigest } from "../lib/ingest.js";

const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082",
  "hex",
);
const CLEAN_HTML = "<!doctype html><html><head><style>body{margin:0}</style></head><body><p>Studio</p><script>document.body.dataset.ready=1</script></body></html>";
const PROBLEM_HTML = "<!doctype html><html><head><style>body{margin:0}</style></head><body><script src=\"https://cdn.example/app.js\"></script><script>fetch(\"https://cdn.example/collect\")</script></body></html>";
const SECRET_HTML = "<!doctype html><html><head><style>a{}</style></head><body><script src=\"postgres://user:secret@db.example/app\"></script></body></html>";
const NOTE = "CLIENT-NOTE-should-stay-off-the-receipt";

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function capture() {
  const stdout = { text: "", write(chunk) { this.text += chunk; } };
  const stderr = { text: "", write(chunk) { this.text += chunk; } };
  return { stdout, stderr, io: { stdout, stderr } };
}

async function writeSnapshot(dir, { html, digestField }) {
  const projectId = "proj_example_001";
  const submissionId = "sub_example_001";
  const assets = [
    ["assets/photo.png", PNG, "gallery"],
    ["assets/viewer.html", Buffer.from(html), "interactive-3d-viewer"],
  ];
  const document = {
    projectId,
    submissionId,
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
    assets: assets.map(([assetPath, , role]) => ({ path: assetPath, role, note: NOTE })),
  };
  const files = [{ path: "content.json", bytes: Buffer.from(`${JSON.stringify(document, null, 2)}\n`) }];
  for (const [assetPath, bytes] of assets) files.push({ path: assetPath, bytes });
  for (const file of files) {
    await mkdir(path.dirname(path.join(dir, file.path)), { recursive: true });
    await writeFile(path.join(dir, file.path), file.bytes);
  }
  const listed = files.map((file) => ({ path: file.path, size: file.bytes.length, sha256: sha256(file.bytes) }));
  const digest = canonicalDigest(projectId, submissionId, listed);
  const ready = { projectId, submissionId, files: listed };
  if (digestField) ready.digest = digest;
  await writeFile(path.join(dir, "READY.json"), `${JSON.stringify(ready, null, 2)}\n`);
  return { projectId, submissionId, digest, listed };
}

function assetRows(text) {
  const lines = text.split("\n");
  const start = lines.indexOf("assets:");
  assert.notEqual(start, -1);
  assert.equal(lines[start + 1], "path\trole\tsize\tsha256\tproblems");
  return lines.slice(start + 2).map((line) => {
    const [filePath, role, size, hash, problems] = line.split("\t");
    return { filePath, role, size: Number(size), hash, problems };
  });
}

async function inspect(dir) {
  const { stdout, stderr, io } = capture();
  const code = await main(["inspect", "--dir", dir], { AMC_ENV_FILE: path.join(dir, "missing.env") }, io);
  return { code, stdout: stdout.text, stderr: stderr.text };
}

test("inspect receipt lists a clean asset's path, role, size, and short hash", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "amc-receipt-"));
  const box = await writeSnapshot(dir, { html: CLEAN_HTML, digestField: true });
  const { code, stdout, stderr } = await inspect(dir);
  assert.equal(code, 0);
  assert.equal(stderr, "");
  assert.match(stdout, new RegExp(`^project: ${box.projectId}$`, "m"));
  assert.match(stdout, new RegExp(`^submission: ${box.submissionId}$`, "m"));
  assert.match(stdout, new RegExp(`^snapshotDigest: ${box.digest}$`, "m"));
  assert.match(stdout, /^manifestDigestMatches: true$/m);
  assert.match(stdout, /^files: 3$/m);
  assert.match(stdout, /^publishable: yes$/m);
  assert.equal(stdout.includes("\nproblem:"), false);
  assert.match(stdout, /^published: false$/m);
  assert.equal(stdout.includes(NOTE), false);
  assert.equal(stdout.includes("Synthetic client"), false);
  const rows = assetRows(stdout);
  assert.deepEqual(rows.map((row) => row.filePath), ["assets/photo.png", "assets/viewer.html"]);
  for (const row of rows) {
    const listed = box.listed.find((file) => file.path === row.filePath);
    assert.equal(row.size, listed.size);
    assert.equal(row.hash, listed.sha256.slice(0, 12));
    assert.equal(row.hash.length, 12);
    assert.equal(stdout.includes(listed.sha256), false);
    assert.equal(row.problems, "none");
  }
  assert.equal(rows[0].role, "gallery");
  assert.equal(rows[1].role, "interactive-3d-viewer");
  const help = capture();
  assert.equal(await main(["help"], {}, help.io), 0);
  assert.match(help.stdout.text, /path, role, size, a 12-character sha256, and problems/);
  assert.match(help.stdout.text, /does not print codes/);
  assert.match(help.stdout.text, /inside a problem is redacted/);
});

test("inspect receipt keeps widget problems on the asset row and redacts credentials", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "amc-receipt-bad-"));
  const box = await writeSnapshot(dir, { html: PROBLEM_HTML, digestField: false });
  const { code, stdout } = await inspect(dir);
  assert.equal(code, 0);
  assert.match(stdout, /^publishable: no$/m);
  assert.match(stdout, /^manifestDigestMatches: absent$/m);
  assert.match(stdout, /^problem: external script src: https:\/\/cdn\.example\/app\.js\. Snapshot was not sealed or published\.$/m);
  const rows = assetRows(stdout);
  const photo = rows.find((row) => row.filePath === "assets/photo.png");
  const widget = rows.find((row) => row.filePath === "assets/viewer.html");
  assert.equal(photo.problems, "none");
  assert.equal(photo.role, "gallery");
  assert.equal(
    widget.problems,
    "external script src: https://cdn.example/app.js | network call | external url: https://cdn.example/app.js",
  );
  assert.equal(widget.hash, box.listed.find((file) => file.path === "assets/viewer.html").sha256.slice(0, 12));
  assert.equal(stdout.includes(NOTE), false);

  const secretDir = await mkdtemp(path.join(tmpdir(), "amc-receipt-secret-"));
  await writeSnapshot(secretDir, { html: SECRET_HTML, digestField: true });
  const secret = await inspect(secretDir);
  assert.equal(secret.code, 0);
  assert.equal(secret.stdout.includes("secret"), false);
  assert.match(secret.stdout, /postgres:\/\/\[redacted\]/);
  assert.match(secret.stdout, /^publishable: no$/m);
});
