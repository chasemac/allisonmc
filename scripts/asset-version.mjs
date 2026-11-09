import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// Public assets are cached for 30 days, so a file replaced at the same path
// would stay stale. The build adds ?v=<content hash> to every reference to a
// file under assets/ in the built HTML; a changed file gets a new URL.
const ASSET_REF = /((?:https:\/\/allisonmc\.com\/|\/)?assets\/[A-Za-z0-9._\/-]+\.[A-Za-z0-9]+)(\?v=[0-9a-f]+)?/g;

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
}

export async function assetHashes(distDir) {
  const hashes = new Map();
  for (const file of await walk(path.join(distDir, "assets"))) {
    const rel = path.relative(distDir, file).split(path.sep).join("/");
    hashes.set(rel, createHash("sha256").update(await readFile(file)).digest("hex").slice(0, 10));
  }
  return hashes;
}

export function versionReferences(html, hashes) {
  return html.replace(ASSET_REF, (match, ref) => {
    const rel = ref.replace(/^https:\/\/allisonmc\.com\//, "").replace(/^\//, "");
    const hash = hashes.get(rel);
    return hash ? `${ref}?v=${hash}` : match;
  });
}

export async function versionHtml(distDir, pages) {
  const hashes = await assetHashes(distDir);
  for (const page of pages) {
    const file = path.join(distDir, page);
    const html = await readFile(file, "utf8");
    await writeFile(file, versionReferences(html, hashes));
  }
  return hashes;
}
