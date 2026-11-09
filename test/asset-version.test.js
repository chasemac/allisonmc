import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { versionHtml, versionReferences } from "../scripts/asset-version.mjs";

const hashes = new Map([["assets/img/a.jpg", "aaaaaaaaaa"], ["assets/img/a-640.webp", "bbbbbbbbbb"]]);

test("asset references get a content-hash query, including srcset and absolute og URLs", () => {
  const html = '<img src="assets/img/a.jpg" srcset="assets/img/a-640.webp 640w, assets/img/a.jpg 900w"><meta content="https://allisonmc.com/assets/img/a.jpg"><a href="/assets/img/a.jpg">';
  const out = versionReferences(html, hashes);
  assert.equal(out, '<img src="assets/img/a.jpg?v=aaaaaaaaaa" srcset="assets/img/a-640.webp?v=bbbbbbbbbb 640w, assets/img/a.jpg?v=aaaaaaaaaa 900w"><meta content="https://allisonmc.com/assets/img/a.jpg?v=aaaaaaaaaa"><a href="/assets/img/a.jpg?v=aaaaaaaaaa">');
  assert.equal(versionReferences(out, hashes), out, "idempotent");
  assert.equal(versionReferences('<img src="assets/img/missing.jpg">', hashes), '<img src="assets/img/missing.jpg">');
});

test("the build step versions every public asset reference with its real content hash", async (t) => {
  // A private copy, because other test files rebuild dist/ in parallel.
  const out = mkdtempSync(path.join(tmpdir(), "amc-assets-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const pages = ["index.html", "musings.html", "view.html", "404.html"];
  for (const item of [...pages, "assets"]) cpSync(item, path.join(out, item), { recursive: true });
  await versionHtml(out, pages);
  assert.match(readFileSync("scripts/prepare-static.mjs", "utf8"), /await versionHtml\(dist, pages\)/);
  for (const page of pages) {
    const html = readFileSync(path.join(out, page), "utf8");
    const refs = [...html.matchAll(/assets\/[A-Za-z0-9._\/-]+\.[A-Za-z0-9]+(\?v=[0-9a-f]+)?/g)];
    assert.ok(refs.length > 0, page);
    for (const [ref, query] of refs) {
      assert.ok(query, `${page}: ${ref} is not versioned`);
      const file = ref.slice(0, ref.indexOf("?"));
      const expected = createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 10);
      assert.equal(query, `?v=${expected}`, ref);
    }
  }
});
