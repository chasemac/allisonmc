import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { PAGES } from "../scripts/pages.mjs";
import { latinNormalUrls, refreshPreloads, replacePreloads } from "../scripts/lato-preloads.mjs";

const pages = PAGES;
const face = (subset, style, weight, file) => `/* ${subset} */\n@font-face {\n  font-family: 'Lato';\n  font-style: ${style};\n  font-weight: ${weight};\n  src: url(https://fonts.gstatic.com/s/lato/v99/${file}.woff2) format('woff2');\n}\n`;
const css = [
  face("latin-ext", "normal", 400, "ext400"),
  face("latin", "italic", 400, "it400"),
  face("latin", "normal", 300, "n300"),
  face("latin", "normal", 400, "n400"),
  face("latin", "normal", 700, "n700"),
].join("");
const fakeFetch = (body, status = 200) => async () => ({ ok: status === 200, status, text: async () => body });
const preloads = (html) => [...html.matchAll(/<link rel="preload" as="font"[^>]*href="([^"]+)"/g)].map((m) => m[1]);

test("picks the latin, upright 300, 400 and 700 woff2 files from the Google stylesheet", () => {
  assert.deepEqual(latinNormalUrls(css), [
    "https://fonts.gstatic.com/s/lato/v99/n300.woff2",
    "https://fonts.gstatic.com/s/lato/v99/n400.woff2",
    "https://fonts.gstatic.com/s/lato/v99/n700.woff2",
  ]);
  assert.throws(() => latinNormalUrls(face("latin", "normal", 300, "n300") + face("latin", "normal", 400, "n400")), /Lato 700/);
  assert.throws(() => latinNormalUrls(css.replace("fonts.gstatic.com/s/lato/v99/n700", "evil.example/x")), /Lato 700/);
});

test("every page carries exactly the generated block: three Lato preloads from fonts.gstatic.com", () => {
  for (const page of pages) {
    const html = readFileSync(page, "utf8");
    assert.equal((html.match(/lato-preloads:start/g) || []).length, 1, page);
    const urls = preloads(html);
    assert.equal(urls.length, 3, page);
    for (const url of urls) assert.match(url, /^https:\/\/fonts\.gstatic\.com\/s\/lato\/.+\.woff2$/);
    assert.equal(replacePreloads(html, urls), html, `${page} block is not in generated form`);
    assert.deepEqual(preloads(readFileSync("index.html", "utf8")), urls, `${page} differs from index.html`);
  }
});

test("the build step rewrites the block from Google, and keeps the committed links when Google fails", async (t) => {
  const out = mkdtempSync(path.join(tmpdir(), "amc-fonts-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  for (const page of pages) cpSync(page, path.join(out, page));
  const kept = await refreshPreloads(out, pages, { fetchImpl: fakeFetch("", 503) });
  assert.equal(kept.refreshed, false);
  for (const page of pages) assert.equal(readFileSync(path.join(out, page), "utf8"), readFileSync(page, "utf8"));
  const broken = await refreshPreloads(out, pages, { fetchImpl: fakeFetch("/* nothing */") });
  assert.equal(broken.refreshed, false);
  const done = await refreshPreloads(out, pages, { fetchImpl: fakeFetch(css) });
  assert.equal(done.refreshed, true);
  for (const page of pages) {
    const html = readFileSync(path.join(out, page), "utf8");
    assert.deepEqual(preloads(html), latinNormalUrls(css));
    assert.match(html, /family=Lato:ital,wght@0,300;0,400;0,700;1,300;1,400;1,700&display=swap/);
  }
  assert.match(readFileSync("scripts/prepare-static.mjs", "utf8"), /await refreshPreloads\(dist, pages\)/);
});
