import crypto from "node:crypto";
import { lstat, readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { DIGEST, PROJECT_ID, SUBMISSION_ID, snapshotMediaPath } from "./codes.js";
import { classifyAsset, mapSubmission, widgetProblems } from "./content-policy.js";
import { SchemaError } from "./errors.js";

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function assertRelative(filePath) {
  if (!filePath || filePath.startsWith("/") || filePath.includes("\\") || filePath.split("/").includes("..")) {
    throw new SchemaError("asset path");
  }
}

async function walkFiles(dir, prefix = "") {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    const stat = await lstat(full);
    if (stat.isSymbolicLink()) throw new SchemaError("symlink refused");
    if (stat.isDirectory()) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(entry.name)) throw new SchemaError("asset path");
      files.push(...(await walkFiles(full, relative)));
    } else if (stat.isFile()) {
      files.push(relative);
    } else {
      throw new SchemaError("asset path");
    }
  }
  return files;
}

export function canonicalDigest(projectId, submissionId, files) {
  const body = JSON.stringify({
    projectId,
    submissionId,
    files: files
      .slice()
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((file) => ({ path: file.path, size: file.size, sha256: file.sha256 })),
  });
  return sha256(Buffer.from(body));
}

export async function inspectSnapshot(dir) {
  const readyBytes = await readFile(path.join(dir, "READY.json"));
  const ready = JSON.parse(readyBytes.toString("utf8"));
  if (!PROJECT_ID.test(ready.projectId || "") || !SUBMISSION_ID.test(ready.submissionId || "")) {
    throw new SchemaError("invalid submission id");
  }
  if (!Array.isArray(ready.files) || ready.files.length < 1) throw new SchemaError("manifest files");
  const listed = new Map();
  for (const file of ready.files) {
    assertRelative(file.path);
    if (file.path === "READY.json" || file.path === "DERIVED.json") throw new SchemaError("manifest files");
    if (listed.has(file.path)) throw new SchemaError("duplicate asset");
    if (!Number.isInteger(file.size) || file.size < 0) throw new SchemaError("manifest size");
    if (!DIGEST.test(file.sha256 || "")) throw new SchemaError("manifest hash");
    listed.set(file.path, file);
  }
  if (!listed.has("content.json")) throw new SchemaError("missing content.json");
  const onDisk = (await walkFiles(dir)).filter((file) => file !== "READY.json" && file !== "DERIVED.json");
  if (onDisk.length !== listed.size) throw new SchemaError("manifest does not match files");
  for (const file of onDisk) {
    if (!listed.has(file)) throw new SchemaError("extra file");
  }
  const classified = new Map();
  for (const [filePath, meta] of listed) {
    const full = path.join(dir, filePath);
    const stat = await lstat(full);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new SchemaError("symlink refused");
    const bytes = await readFile(full);
    if (bytes.length !== meta.size) throw new SchemaError("manifest size");
    if (sha256(bytes) !== meta.sha256) throw new SchemaError("manifest hash");
    if (filePath === "content.json") {
      classified.set(filePath, { bytes, text: bytes.toString("utf8") });
    } else {
      classified.set(filePath, classifyAsset(path.basename(filePath), bytes));
    }
  }
  const document = JSON.parse(classified.get("content.json").text);
  if (document.projectId !== ready.projectId || document.submissionId !== ready.submissionId) {
    throw new SchemaError("ids do not agree");
  }
  const assetFiles = new Map([...classified].filter(([filePath]) => filePath !== "content.json"));
  const mapped = mapSubmission(document, assetFiles);
  const digest = canonicalDigest(ready.projectId, ready.submissionId, [...listed.values()]);
  let manifestDigest = null;
  if (ready.digest !== undefined) {
    if (typeof ready.digest !== "string" || !DIGEST.test(ready.digest)) throw new SchemaError("manifest digest");
    manifestDigest = ready.digest;
  }
  return {
    dir,
    ready,
    document,
    mapped,
    digest,
    manifestDigest,
    manifestDigestMatches: manifestDigest === null ? null : manifestDigest === digest,
    listed,
  };
}

export function assertPublishable(inspected) {
  for (const asset of inspected.mapped.assets) {
    if (asset.kind === "widget" && asset.problems?.length) {
      throw new SchemaError(`${asset.problems[0]}. Snapshot was not sealed or published.`);
    }
  }
}

export async function sealSnapshot(services, inspected) {
  assertPublishable(inspected);
  const registered = await services.store.getProject(inspected.ready.projectId);
  if (!registered) throw new SchemaError("Unknown project.");
  const existing = await services.store.getSnapshot(inspected.ready.projectId, inspected.ready.submissionId);
  if (existing && existing.digest !== inspected.digest) throw new SchemaError("submission digest conflict");
  if (existing && existing.files.length === inspected.mapped.assets.length) {
    return { idempotent: true, digest: existing.digest, published: false };
  }
  for (const asset of inspected.mapped.assets) {
    const pathname = snapshotMediaPath(inspected.ready.projectId, inspected.digest, asset.mediaId);
    await services.media.put(pathname, asset.bytes, asset.contentType);
  }
  await services.store.sealSnapshot({
    projectId: inspected.ready.projectId,
    submissionId: inspected.ready.submissionId,
    digest: inspected.digest,
    presentation: inspected.mapped.presentation,
    files: inspected.mapped.assets.map((asset) => ({
      path: asset.path,
      sha256: sha256(asset.bytes),
      size: asset.bytes.length,
      mediaId: asset.mediaId,
      contentType: asset.contentType,
      filename: asset.filename,
    })),
  });
  return { idempotent: false, digest: inspected.digest, published: false };
}

async function materialize(services, snapshot) {
  await services.store.upsertProject(snapshot.presentation);
  for (const file of snapshot.files) {
    await services.store.putMedia({
      projectId: snapshot.projectId,
      mediaId: file.mediaId,
      pathname: snapshotMediaPath(snapshot.projectId, snapshot.digest, file.mediaId),
      contentType: file.contentType,
      filename: file.filename,
      byteLength: file.size,
    });
  }
}

export async function approveSnapshot(services, { projectId, submissionId, digest, operation }) {
  if (!["publish", "rollback"].includes(operation)) throw new SchemaError("approval operation");
  const snapshot = await services.store.getSnapshot(projectId, submissionId);
  if (!snapshot || snapshot.digest !== digest) throw new SchemaError("approval does not match a sealed snapshot");
  await services.store.putApproval({ projectId, submissionId, digest, operation });
  return { approved: true, published: false };
}

export async function publishSnapshot(services, { projectId, submissionId, digest }) {
  const snapshot = await services.store.getSnapshot(projectId, submissionId);
  if (!snapshot || snapshot.digest !== digest) throw new SchemaError("unknown snapshot");
  if (!(await services.store.hasApproval({ projectId, submissionId, digest, operation: "publish" }))) {
    throw new SchemaError("approval required");
  }
  const current = await services.store.getPublication(projectId);
  if (current && current.digest === digest && current.submissionId === submissionId) {
    await materialize(services, snapshot);
    return { idempotent: true, version: current.version, published: true };
  }
  const next = await services.store.compareAndSetPublication({
    projectId,
    submissionId,
    digest,
    expectedVersion: current ? current.version : 0,
  });
  await materialize(services, snapshot);
  return { idempotent: false, version: next.version, published: true };
}

export async function rollbackSnapshot(services, { projectId, submissionId, digest }) {
  const snapshot = await services.store.getSnapshot(projectId, submissionId);
  if (!snapshot || snapshot.digest !== digest) throw new SchemaError("unknown snapshot");
  if (!(await services.store.hasApproval({ projectId, submissionId, digest, operation: "rollback" }))) {
    throw new SchemaError("approval required");
  }
  const current = await services.store.getPublication(projectId);
  const next = await services.store.compareAndSetPublication({
    projectId,
    submissionId,
    digest,
    expectedVersion: current ? current.version : 0,
  });
  await materialize(services, snapshot);
  return { version: next.version, published: true, codesChanged: false };
}

function stripExternalScripts(html) {
  return html.replace(/<script\b[^>]*\bsrc\s*=\s*(['"])https?:\/\/[^'"]+\1[^>]*>\s*<\/script>/gi, "");
}

export async function deriveStrippedSnapshot(sourceDir, outDir, submissionId) {
  if (!SUBMISSION_ID.test(submissionId || "")) throw new SchemaError("invalid submission id");
  const source = path.resolve(sourceDir);
  const output = path.resolve(outDir);
  if (source === output || output.startsWith(`${source}${path.sep}`)) throw new SchemaError("output directory");
  const before = await readFile(path.join(source, "READY.json"));
  const inspected = await inspectSnapshot(source);
  if (inspected.ready.submissionId === submissionId) throw new SchemaError("derived submission must be new");
  let strippedCount = 0;
  const written = [];
  await mkdir(path.join(output, "assets"), { recursive: true });
  const document = structuredClone(inspected.document);
  document.submissionId = submissionId;
  for (const filePath of inspected.listed.keys()) {
    if (filePath === "content.json") continue;
    const sourceBytes = await readFile(path.join(source, filePath));
    let bytes = sourceBytes;
    if (filePath.endsWith(".html")) {
      const stripped = stripExternalScripts(sourceBytes.toString("utf8"));
      if (stripped !== sourceBytes.toString("utf8")) {
        const problems = widgetProblems(Buffer.from(stripped));
        if (problems.length) throw new SchemaError(problems[0]);
        bytes = Buffer.from(stripped);
        strippedCount += 1;
      }
    }
    await mkdir(path.dirname(path.join(output, filePath)), { recursive: true });
    await writeFile(path.join(output, filePath), bytes);
    written.push({ path: filePath, size: bytes.length, sha256: sha256(bytes) });
  }
  if (!strippedCount) throw new SchemaError("nothing to strip");
  const contentBytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`);
  await writeFile(path.join(output, "content.json"), contentBytes);
  const files = written.concat([{ path: "content.json", size: contentBytes.length, sha256: sha256(contentBytes) }]);
  const outputDigest = canonicalDigest(document.projectId, submissionId, files);
  const ready = { projectId: document.projectId, submissionId, digest: outputDigest, files };
  await writeFile(path.join(output, "READY.json"), Buffer.from(`${JSON.stringify(ready, null, 2)}\n`));
  await writeFile(
    path.join(output, "DERIVED.json"),
    Buffer.from(`${JSON.stringify({
      derivedFrom: {
        projectId: inspected.ready.projectId,
        submissionId: inspected.ready.submissionId,
        snapshotDigest: inspected.digest,
        manifestDigest: inspected.manifestDigest,
      },
      operation: "strip-unused-external-scripts",
      outputDigest,
      published: false,
    }, null, 2)}\n`),
  );
  const sourceAfter = await readFile(path.join(source, "READY.json"));
  if (!sourceAfter.equals(before)) throw new SchemaError("original changed");
  return { inputDigest: inspected.digest, outputDigest, published: false };
}
