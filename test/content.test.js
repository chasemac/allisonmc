import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { TEST_FIXTURE_CODE } from "../lib/demo-fixture.js";

const pages = ["index.html", "musings.html", "view.html"];

function contrast(a, b) {
  const lum = ([r, g, b]) => {
    const f = (u) => {
      const channel = u / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const hex = (value) => [1, 3, 5].map((index) => Number.parseInt(value.slice(index, index + 2), 16));
  const [L1, L2] = [lum(hex(a)), lum(hex(b))].sort((left, right) => right - left);
  return (L1 + 0.05) / (L2 + 0.05);
}

test("agent and publishing docs stay free of the fixture code and credentials", () => {
  const docs = ["AGENTS.md", "README.md", "docs/runbook.md", "docs/publishing/WORKFLOW.md"]
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
  assert.equal(docs.includes(TEST_FIXTURE_CODE), false);
  assert.equal(docs.includes("postgres://"), false);
  assert.equal(/BLOB_READ_WRITE_TOKEN\s*=\s*\S+/.test(docs), false);
});

test("public pages keep Allison's existing copy, links, and photo", () => {
  const home = readFileSync("index.html", "utf8");
  const musings = readFileSync("musings.html", "utf8");
  assert.match(home, /I grew up regularly relocating with my family to various cities mainly within Texas and Oklahoma\. The familiarity to transition is what began to shape my character- eventually instilling within me a desire for great adventure and even greater design\. Several years ago my big adventure to Master Architecture lead me to finally put down roots in Southern California\./);
  assert.match(home, /Dreamer/);
  assert.match(home, /Designer/);
  assert.match(home, /Doer/);
  assert.match(home, /Allison McElroy/);
  assert.match(musings, /If there's one thing I love more than surprises, it's helping a good friend with a surprise proposal!/);
  assert.match(musings, /Just a glimpse at our amazing friendcation to Banff, Canada\. Thanks to our favorite Canadian couple for tying the knot and giving us Californians an excuse to visit your amazing home\./);
  assert.match(musings, /Shoutout to our amazing photographers at Hom Photography and my now husband Chase for his invitation production skills\. Thank you all for making my wedding dreams come true\./);
  for (const page of [home, musings, readFileSync("view.html", "utf8")]) {
    assert.match(page, /&copy; AllisonMc 2022\. All Rights Reserved\./);
    assert.match(page, /https:\/\/www\.behance\.net\/gallery\/27744549\/Allison-Gay-Portfolio/);
    assert.match(page, /https:\/\/www\.linkedin\.com\/in\/allisongaymcelroy\//);
  }
  const view = readFileSync("view.html", "utf8");
  assert.equal(/<form[\s>]/i.test(view), false);
  assert.equal(view.includes('name="code"'), false);
  assert.match(view, /id="access-submit"[^>]*type="button"|type="button"[^>]*id="access-submit"/);
  assert.match(home, /assets\/img\/allisonProfile\.jpg/);
  assert.match(musings, /assets\/img\/boards\.jpeg/);
  assert.match(musings, /assets\/img\/banf\.jpg/);
  assert.match(musings, /assets\/img\/weddingInvites\.jpeg/);
  assert.equal(musings.includes("banf.png"), false);
});

test("pages link to real files and do not load the old template", () => {
  for (const page of pages) {
    const html = readFileSync(page, "utf8");
    assert.equal((html.match(/<h1[\s>]/g) || []).length, 1);
    assert.equal(html.includes("startbootstrap"), false);
    assert.equal(html.includes("bootstrap"), false);
    assert.equal(html.includes("scripts.js"), false);
    assert.equal(html.includes(TEST_FIXTURE_CODE), false);
    for (const match of html.matchAll(/href="([^"]+)"/g)) {
      const href = match[1];
      if (href.startsWith("http") || href.startsWith("#")) continue;
      assert.equal(existsSync(href.split("#")[0]), true, `${page} -> ${href}`);
    }
    for (const match of html.matchAll(/src="([^"]+)"/g)) {
      const src = match[1];
      if (src.startsWith("http")) continue;
      assert.equal(existsSync(src), true, `${page} -> ${src}`);
    }
    for (const anchor of html.match(/<a [^>]*target="_blank"[^>]*>/g) || []) {
      assert.match(anchor, /rel="noopener noreferrer"/);
    }
  }
  for (const match of readFileSync("musings.html", "utf8").matchAll(/<img [^>]*>/g)) {
    assert.match(match[0], /alt="[^"]+"/);
  }
  assert.match(readFileSync("index.html", "utf8"), /alt="[^"]+"/);
  const css = readFileSync("css/styles.css", "utf8");
  assert.match(css, /:focus-visible/);
  assert.match(css, /prefers-reduced-motion/);
  const colors = Object.fromEntries([...css.matchAll(/--(paper|ink|cypress|muted|danger):\s*(#[0-9a-f]{6})/g)].map((item) => [item[1], item[2]]));
  assert.ok(contrast(colors.ink, colors.paper) >= 7);
  assert.ok(contrast(colors.muted, colors.paper) >= 4.5);
  assert.ok(contrast(colors.cypress, colors.paper) >= 4.5);
  assert.ok(contrast("#f6f1e8", colors.cypress) >= 4.5);
  assert.ok(contrast(colors.ink, "#fffdf9") >= 7);
  assert.ok(contrast(colors.muted, "#fffdf9") >= 4.5);
  assert.ok(contrast(colors.cypress, "#fffdf9") >= 4.5);
  assert.ok(contrast(colors.danger, colors.paper) >= 4.5);
  const lato = "family=Lato:ital,wght@0,300;0,400;0,700;1,300;1,400;1,700";
  for (const page of ["index.html", "musings.html", "view.html", "404.html"]) {
    const html = readFileSync(page, "utf8");
    assert.equal(html.includes(lato), true, page);
    assert.equal(/Fraunces|Outfit/.test(html), false, page);
  }
  assert.match(css, /--font:\s*"Lato"/);
  assert.equal(/Fraunces|Outfit/.test(css), false);
  assert.match(css, /h1,\s*h2,\s*h3,[\s\S]*?font-weight:\s*700/);
});

test("static output omits server code, secrets, and the fixture code", () => {
  const built = spawnSync(process.execPath, ["scripts/prepare-static.mjs"], { encoding: "utf8", env: { ...process.env, AMC_FONT_PRELOADS: "skip" } });
  assert.equal(built.status, 0, built.stderr);
  assert.equal(existsSync("dist/index.html"), true);
  assert.equal(existsSync("dist/lib"), false);
  assert.equal(existsSync("dist/fixtures"), false);
  assert.equal(existsSync("dist/server.mjs"), false);
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(html|css|js|json|txt|mjs)$/.test(name)) files.push(full);
    }
  };
  walk("dist");
  const blob = files.map((file) => readFileSync(file, "utf8")).join("\n");
  assert.equal(blob.includes(TEST_FIXTURE_CODE), false);
  assert.equal(blob.includes("CODE_PEPPER"), false);
  assert.equal(blob.includes("BLOB_READ_WRITE_TOKEN"), false);
  assert.equal(blob.includes("postgres://"), false);
  const serverSource = ["api/handler.js", "lib/router.js", "lib/runtime.js"].map((file) => readFileSync(file, "utf8")).join("\n");
  assert.equal(serverSource.includes(TEST_FIXTURE_CODE), false);
  assert.equal(serverSource.includes("demo-fixture.js"), false);
});
