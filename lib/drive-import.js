import crypto from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import { DIGEST } from "./codes.js";
import { SchemaError } from "./errors.js";
import { canonicalDigest, inspectSnapshot } from "./ingest.js";
import { MAX_MEDIA_BYTES } from "./media-types.js";

const SHORTCUT_EXTENSIONS = [".gdoc", ".gsheet", ".gslides", ".gform", ".gdraw"];

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function overlaps(left, right) {
  return isInside(left, right) || isInside(right, left);
}

function displayPath(relative) {
  return relative.replace(/[\r\n\0]/g, "");
}

function joinInside(root, relative) {
  if (typeof relative !== "string" || !relative || path.isAbsolute(relative) || relative.includes("\\") || relative.includes("\0")) {
    throw new SchemaError("path traversal refused");
  }
  const parts = relative.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) throw new SchemaError("path traversal refused");
  const full = path.resolve(root, ...parts);
  const normalRoot = path.resolve(root);
  if (!isInside(normalRoot, full)) throw new SchemaError("path traversal refused");
  return full;
}

function refuseEntryName(name, relative) {
  if (typeof name !== "string" || !name || name.includes("/") || name.includes("\\") || name.includes("\0") || name === "." || name === "..") {
    throw new SchemaError("path traversal refused");
  }
  const lower = name.toLowerCase();
  const label = displayPath(relative);
  if (lower === ".ds_store") throw new SchemaError(`refused .DS_Store: ${label}`);
  if (name === "Icon\r" || name === "Icon\r\n" || (name.startsWith("Icon") && /[\r\n]/.test(name))) {
    throw new SchemaError(`refused macOS Icon file: ${label}`);
  }
  if (lower === "desktop.ini") throw new SchemaError(`refused desktop.ini: ${label}`);
  if (name.startsWith("~$")) throw new SchemaError(`refused Office lock file: ${label}`);
  if (SHORTCUT_EXTENSIONS.some((extension) => lower.endsWith(extension))) {
    throw new SchemaError(`refused Google Docs shortcut: ${label}`);
  }
  if (name.startsWith("._")) {
    throw new SchemaError(`refused AppleDouble file: ${label}. Remove it with dot_clean on the snapshot folder, then import again.`);
  }
  if (name.startsWith(".")) throw new SchemaError(`hidden file refused: ${label}`);
  if (lower === "project-access.json") throw new SchemaError("codes belong in the separate access file");
}

async function readNoFollow(full, label) {
  let handle;
  try {
    handle = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (err) {
    if (err.code === "ELOOP") throw new SchemaError(`symlink refused: ${displayPath(label)}`);
    throw err;
  }
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new SchemaError("asset path");
    if (!Number.isSafeInteger(before.size) || before.size > MAX_MEDIA_BYTES) throw new SchemaError("media file is too large");
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (!after.isFile() || before.size !== after.size || bytes.length !== after.size) {
      throw new SchemaError("still syncing, try again");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function writeNoFollow(file, bytes) {
  let handle;
  try {
    handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  } catch (err) {
    if (err.code === "EEXIST" || err.code === "ELOOP") throw new SchemaError("symlink refused");
    throw err;
  }
  try {
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
}

async function walk(root, relative, files) {
  const current = relative ? joinInside(root, relative) : root;
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
    refuseEntryName(entry.name, childRelative);
    const full = joinInside(root, childRelative);
    const stat = await lstat(full);
    if (entry.isSymbolicLink() || stat.isSymbolicLink()) throw new SchemaError(`symlink refused: ${displayPath(childRelative)}`);
    if (stat.isDirectory()) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(entry.name)) throw new SchemaError("asset path");
      await walk(root, childRelative, files);
      continue;
    }
    if (!stat.isFile()) throw new SchemaError("asset path");
    const bytes = await readNoFollow(full, childRelative);
    files.set(childRelative, { size: bytes.length, sha256: sha256(bytes) });
  }
}

async function scanSubmission(dir) {
  if (!dir || typeof dir !== "string") throw new SchemaError("Missing snapshot directory.");
  const resolved = path.resolve(dir);
  let stat;
  try {
    stat = await lstat(resolved);
  } catch (err) {
    if (err.code === "ENOENT") throw new SchemaError("Missing snapshot directory.");
    throw err;
  }
  if (stat.isSymbolicLink()) throw new SchemaError("symlink refused");
  if (!stat.isDirectory()) throw new SchemaError("Missing snapshot directory.");
  const root = await realpath(resolved);
  const files = new Map();
  await walk(root, "", files);
  return { root, files };
}

function scansEqual(left, right) {
  if (left.root !== right.root || left.files.size !== right.files.size) return false;
  for (const [filePath, meta] of left.files) {
    const other = right.files.get(filePath);
    if (!other || other.size !== meta.size || other.sha256 !== meta.sha256) return false;
  }
  return true;
}

function assertManifestPath(filePath) {
  if (typeof filePath !== "string" || !filePath || path.isAbsolute(filePath) || filePath.includes("\\") || filePath.includes("\0")) {
    throw new SchemaError("path traversal refused");
  }
  const parts = filePath.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) throw new SchemaError("path traversal refused");
}

async function assertManifest(scan) {
  const readyMeta = scan.files.get("READY.json");
  if (!readyMeta) throw new SchemaError("READY.json is missing");
  const readyBytes = await readNoFollow(path.join(scan.root, "READY.json"), "READY.json");
  if (readyBytes.length !== readyMeta.size || sha256(readyBytes) !== readyMeta.sha256) {
    throw new SchemaError("still syncing, try again");
  }
  let ready;
  try {
    ready = JSON.parse(readyBytes.toString("utf8"));
  } catch {
    throw new SchemaError("READY.json is not valid JSON");
  }
  if (!ready || typeof ready !== "object" || Array.isArray(ready)) throw new SchemaError("manifest files");
  if (!Array.isArray(ready.files) || ready.files.length < 1) throw new SchemaError("manifest files");
  const listed = new Map();
  for (const file of ready.files) {
    if (!file || typeof file !== "object" || Array.isArray(file)) throw new SchemaError("manifest files");
    assertManifestPath(file.path);
    if (file.path === "READY.json" || file.path === "DERIVED.json") throw new SchemaError("manifest files");
    if (listed.has(file.path)) throw new SchemaError("duplicate asset");
    if (!Number.isInteger(file.size) || file.size < 0) throw new SchemaError("manifest size");
    if (typeof file.sha256 !== "string" || !DIGEST.test(file.sha256)) throw new SchemaError("manifest hash");
    listed.set(file.path, { path: file.path, size: file.size, sha256: file.sha256 });
  }
  if (!listed.has("content.json")) throw new SchemaError("missing content.json");
  const onDisk = [...scan.files.keys()].filter((filePath) => filePath !== "READY.json" && filePath !== "DERIVED.json");
  if (onDisk.length !== listed.size) throw new SchemaError("manifest does not match files");
  for (const filePath of onDisk) {
    if (!listed.has(filePath)) throw new SchemaError("extra file");
  }
  for (const [filePath, meta] of listed) {
    const found = scan.files.get(filePath);
    if (!found) throw new SchemaError("manifest does not match files");
    if (found.size !== meta.size) throw new SchemaError("manifest size");
    if (found.sha256 !== meta.sha256) throw new SchemaError("manifest hash");
  }
  if (ready.digest !== undefined) {
    if (typeof ready.digest !== "string" || !DIGEST.test(ready.digest)) throw new SchemaError("manifest digest");
    const digest = canonicalDigest(ready.projectId, ready.submissionId, [...listed.values()]);
    if (ready.digest !== digest) throw new SchemaError("manifest digest does not match");
  }
}

async function ensureDir(root, parts) {
  let relative = "";
  for (const part of parts) {
    relative = relative ? `${relative}/${part}` : part;
    const full = joinInside(root, relative);
    let existing = null;
    try {
      existing = await lstat(full);
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
    if (!existing) {
      try {
        await mkdir(full);
      } catch (err) {
        if (err.code !== "EEXIST") throw err;
      }
      existing = await lstat(full);
    }
    if (existing.isSymbolicLink()) throw new SchemaError(`symlink refused: ${displayPath(relative)}`);
    if (!existing.isDirectory()) throw new SchemaError("asset path");
    const real = await realpath(full);
    if (!isInside(root, real)) throw new SchemaError("path traversal refused");
  }
}

async function prepareOutput(sourceRoot, outDir) {
  if (!outDir || typeof outDir !== "string") throw new SchemaError("Missing output directory.");
  const resolved = path.resolve(outDir);
  const parent = path.dirname(resolved);
  const base = path.basename(resolved);
  if (!base || base === "." || base === ".." || base.includes("\0") || base.includes("/") || base.includes("\\")) {
    throw new SchemaError("output directory");
  }
  let parentStat;
  try {
    parentStat = await lstat(parent);
  } catch (err) {
    if (err.code === "ENOENT") throw new SchemaError("output directory");
    throw err;
  }
  if (parentStat.isSymbolicLink()) throw new SchemaError("symlink refused");
  if (!parentStat.isDirectory()) throw new SchemaError("output directory");
  const parentReal = await realpath(parent);
  const intended = path.join(parentReal, base);
  if (overlaps(sourceRoot, intended)) throw new SchemaError("output directory");
  let existing = null;
  try {
    existing = await lstat(intended);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  if (existing?.isSymbolicLink()) throw new SchemaError("symlink refused");
  if (existing) throw new SchemaError("output directory");
  await mkdir(intended);
  const created = await lstat(intended);
  if (created.isSymbolicLink() || !created.isDirectory()) {
    await unlink(intended).catch(() => {});
    throw new SchemaError("symlink refused");
  }
  const createdReal = await realpath(intended);
  if (createdReal !== intended || overlaps(sourceRoot, createdReal)) {
    if (!overlaps(sourceRoot, intended)) await rmdir(intended).catch(() => {});
    throw new SchemaError("output directory");
  }
  return createdReal;
}

async function copyFiles(scan, out) {
  for (const relative of [...scan.files.keys()].sort()) {
    const expected = scan.files.get(relative);
    const bytes = await readNoFollow(joinInside(scan.root, relative), relative);
    if (bytes.length !== expected.size || sha256(bytes) !== expected.sha256) {
      throw new SchemaError("still syncing, try again");
    }
    await ensureDir(out, relative.split("/").slice(0, -1));
    const dest = joinInside(out, relative);
    try {
      await writeNoFollow(dest, bytes);
    } catch (err) {
      if (err instanceof SchemaError) throw err;
      if (err.code === "EEXIST" || err.code === "ELOOP") throw new SchemaError(`symlink refused: ${displayPath(relative)}`);
      throw err;
    }
    const copied = await readNoFollow(dest, relative);
    if (copied.length !== expected.size || sha256(copied) !== expected.sha256) {
      throw new SchemaError("still syncing, try again");
    }
  }
}

async function removeTree(dir) {
  const stat = await lstat(dir);
  if (stat.isSymbolicLink()) {
    await unlink(dir);
    return;
  }
  if (stat.isDirectory()) {
    for (const name of await readdir(dir)) {
      if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\0")) {
        throw new SchemaError("path traversal refused");
      }
      await removeTree(path.join(dir, name));
    }
    await rmdir(dir);
    return;
  }
  await unlink(dir);
}

async function removeCreated(dir, sourceRoot) {
  const resolved = path.resolve(dir);
  if (overlaps(resolved, sourceRoot)) return;
  await removeTree(resolved);
}

export async function importDriveSnapshot(sourceDir, outDir, options = {}) {
  const first = await scanSubmission(sourceDir);
  if (typeof options.betweenScans === "function") await options.betweenScans(first.root);
  const second = await scanSubmission(sourceDir);
  if (!scansEqual(first, second)) throw new SchemaError("still syncing, try again");
  await assertManifest(second);
  if (typeof options.beforeCopy === "function") await options.beforeCopy(second.root);
  const out = await prepareOutput(second.root, outDir);
  try {
    await copyFiles(second, out);
    const inspected = await inspectSnapshot(out);
    if (inspected.manifestDigestMatches === false) throw new SchemaError("manifest digest does not match");
    return { out, inspected };
  } catch (err) {
    await removeCreated(out, second.root).catch(() => {});
    throw err;
  }
}
