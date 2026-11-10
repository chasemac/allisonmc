import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { publicRelativePath } from "../lib/static-public.js";
import { PAGES, SITE_PAGES } from "../scripts/pages.mjs";

const pages = PAGES;
const latoHref = "https://fonts.googleapis.com/css2?family=Lato:ital,wght@0,300;0,400;0,700;1,300;1,400;1,700&display=swap";

function jpegSize(bytes) {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    }
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2;
      continue;
    }
    const length = bytes.readUInt16BE(offset + 2);
    offset += 2 + length;
  }
  throw new Error("JPEG size was not found");
}

function images(html) {
  return [...html.matchAll(/<img\b[^>]*>/g)].map((match) => match[0]);
}

function attr(tag, name) {
  const match = tag.match(new RegExp(`\\b${name}="([^"]*)"`));
  return match ? match[1] : null;
}

test("public images declare alt text and a stable aspect ratio", () => {
  for (const page of pages.filter((page) => page !== "view.html")) {
    for (const tag of images(readFileSync(page, "utf8"))) {
      const alt = attr(tag, "alt");
      const src = attr(tag, "src");
      assert.equal(typeof alt, "string", `${page} img missing alt`);
      assert.equal(alt.length > 0, true, `${page} content image needs alt text`);
      const width = Number(attr(tag, "width"));
      const height = Number(attr(tag, "height"));
      assert.equal(Number.isInteger(width) && width > 0, true, tag);
      assert.equal(Number.isInteger(height) && height > 0, true, tag);
      if (src && /\.jpe?g$/.test(src)) {
        const size = jpegSize(readFileSync(src));
        assert.equal(size.width, width, src);
        assert.equal(size.height, height, src);
      }
    }
  }
  // view.html: the two brand wordmarks plus the empty lightbox image that view.js fills in.
  const viewImages = images(readFileSync("view.html", "utf8"));
  assert.equal(viewImages.length, 3);
  assert.deepEqual(viewImages.filter((tag) => attr(tag, "src") === null).map((tag) => attr(tag, "alt")), [""]);
  assert.equal(viewImages.filter((tag) => /^assets\/img\/wordmark-/.test(attr(tag, "src") || "")).length, 2);
});

test("musings photos use sized WebP and lazy-load below the first image", () => {
  const html = readFileSync("musings.html", "utf8");
  const tags = images(html);
  assert.equal(tags.length, 3);
  assert.equal(attr(tags[0], "fetchpriority"), "high");
  assert.equal(attr(tags[0], "loading"), null);
  for (const tag of tags.slice(1)) {
    assert.equal(attr(tag, "loading"), "lazy");
    assert.equal(attr(tag, "decoding"), "async");
  }
  const sources = [...html.matchAll(/<source\b[^>]*>/g)].map((match) => match[0]);
  assert.equal(sources.length, 3);
  for (const source of sources) {
    assert.equal(attr(source, "type"), "image/webp");
    for (const part of attr(source, "srcset").split(",")) {
      const url = part.trim().split(/\s+/)[0];
      assert.equal(url.endsWith(".webp"), true, url);
      assert.equal(readFileSync(url).subarray(0, 4).toString(), "RIFF", url);
    }
  }
  const home = readFileSync("legacy-home.html", "utf8");
  assert.match(home, /assets\/img\/allisonProfile-400\.webp 400w/);
  assert.match(home, /assets\/img\/allisonProfile-520\.webp 520w/);
  assert.match(home, /assets\/img\/allisonProfile\.jpg/);
});

test("Lato is the only webfont and it swaps instead of hiding text", () => {
  for (const sheet of ["css/styles.css", "css/site.css", "css/portal.css"]) {
    const css = readFileSync(sheet, "utf8").replace(/@font-face\s*\{[^}]*\}/g, "");
    // portal.css loads after site.css and uses its --font.
    if (sheet !== "css/portal.css") assert.match(css, /--font:\s*"Lato",\s*-apple-system/, sheet);
    const withoutStack = css.replace(/--font:\s*[^;]+;/, "");
    assert.equal(/Fraunces|Outfit|Georgia|Garamond|Merriweather|Playfair|Montserrat|Inter\b/.test(withoutStack), false, sheet);
    for (const declared of withoutStack.matchAll(/font-family:\s*([^;]+);/g)) {
      assert.match(declared[1], /var\(--font\)/, declared[1]);
    }
  }
  const faces = readFileSync("css/site.css", "utf8");
  assert.equal((faces.match(/font-display:\s*swap/g) || []).length, 6);
  for (const page of pages) {
    const html = readFileSync(page, "utf8");
    const designer = SITE_PAGES.includes(page);
    assert.equal(html.includes(latoHref), !designer, page);
    assert.equal(html.includes('rel="preconnect" href="https://fonts.googleapis.com"'), !designer, page);
    assert.equal(html.includes('rel="preconnect" href="https://fonts.gstatic.com" crossorigin'), true, page);
    const preloads = [...html.matchAll(/<link rel="preload" as="font"[^>]*>/g)].map((match) => match[0]);
    assert.equal(preloads.length, 3, page);
    for (const link of preloads) {
      assert.match(attr(link, "href"), /^https:\/\/fonts\.gstatic\.com\/s\/lato\/.+\.woff2$/);
      assert.match(link, /\bcrossorigin\b/);
      assert.equal(faces.includes(attr(link, "href")), true, page);
    }
    assert.equal(/<meta name="viewport" content="width=device-width, initial-scale=1"/.test(html), true, page);
    assert.equal(/<meta name="description" content="[^"]+"/.test(html), true, page);
    assert.equal(html.includes("innerHTML"), false, page);
  }
});

test("the project code field is labeled and its error is tied to the field", () => {
  const view = readFileSync("view.html", "utf8");
  assert.equal(/<form[\s>]/i.test(view), false);
  assert.equal(view.includes('name="code"'), false);
  assert.match(view, /id="access-hint"/);
  assert.match(view, /for="project-code"/);
  assert.match(view, /aria-describedby="access-hint form-error"/);
  assert.match(view, /aria-required="true"/);
  assert.match(view, /id="form-error"[^>]*role="alert"/);
  assert.match(readFileSync("404.html", "utf8"), /<a class="skip" href="#content">Skip to content<\/a>/);
});

test("static asset caching is long and HTML, CSS, and JS stay revalidated", () => {
  const config = JSON.parse(readFileSync("vercel.json", "utf8"));
  const header = (source, key) => {
    const rule = config.headers.find((item) => item.source === source);
    assert.ok(rule, source);
    return rule.headers.find((item) => item.key === key).value;
  };
  assert.match(header("/assets/(.*)", "Cache-Control"), /max-age=2592000/);
  assert.match(header("/api/(.*)", "Cache-Control"), /no-store/);
  assert.match(header("/(.*\\.html)", "Cache-Control"), /max-age=0/);
  assert.match(header("/", "Cache-Control"), /must-revalidate/);
  assert.match(header("/css/(.*)", "Cache-Control"), /must-revalidate/);
  assert.match(header("/js/(.*)", "Cache-Control"), /must-revalidate/);
  assert.equal(header("/css/(.*)", "Cache-Control").includes("immutable"), false);
  assert.equal(header("/js/(.*)", "Cache-Control").includes("immutable"), false);
});

test("mobile nav drawer links fill the drawer width at a 48px tap height", () => {
  const css = readFileSync("css/styles.css", "utf8");
  const mobile = css.slice(css.indexOf("@media (max-width: 799px)"));
  const rule = mobile.match(/\n  \.nav a \{([^}]*)\}/);
  assert.ok(rule, "mobile .nav a rule");
  assert.match(rule[1], /width:\s*100%/);
  assert.match(rule[1], /min-height:\s*48px/);
  assert.match(mobile, /\.nav-toggle:checked ~ ul li \{\s*width:\s*100%;/);
});

test("the desktop nav checkbox is not a tab stop, and focus stays visible on dark bands", () => {
  const css = readFileSync("css/site.css", "utf8");
  const wide = css.slice(css.indexOf("@media (min-width: 900px)"));
  assert.match(wide, /\.nav-toggle \{\s*display:\s*none;/);
  assert.match(css, /\.band-slate :focus-visible,\s*\.site-footer :focus-visible \{\s*outline-color:\s*var\(--soft-white\);/);
  assert.match(css, /text-decoration-color:\s*var\(--pine\);/);
});

test("public pages lazy-load the footer wordmark and the missing page is not indexed", () => {
  for (const page of SITE_PAGES) {
    const html = readFileSync(page, "utf8");
    assert.match(html, /alt="Allison McElroy Design" decoding="async" loading="lazy"/, page);
  }
  assert.match(readFileSync("404.html", "utf8"), /<meta name="robots" content="noindex" \/>/);
  assert.equal(readFileSync("index.html", "utf8").includes('name="robots"'), false);
});

test("robots.txt and the sitemap cover the public pages and hide the private ones", () => {
  const robots = readFileSync("robots.txt", "utf8");
  assert.match(robots, /Sitemap: https:\/\/allisonmc\.com\/sitemap\.xml/);
  for (const path of ["/view", "/api/", "/musings", "/legacy-home.html"]) assert.match(robots, new RegExp(`Disallow: ${path.replaceAll("/", "\\/")}`));
  const sitemap = readFileSync("sitemap.xml", "utf8");
  for (const loc of [
    "https://allisonmc.com/",
    "https://allisonmc.com/work.html",
    "https://allisonmc.com/work-mcelroy-kitchen.html",
    "https://allisonmc.com/services.html",
    "https://allisonmc.com/about.html",
    "https://allisonmc.com/inquire.html",
  ]) {
    assert.equal(sitemap.includes(`<loc>${loc}</loc>`), true, loc);
  }
  assert.equal(/view|musings|legacy-home|404\.html/.test(sitemap), false);
  assert.equal(publicRelativePath("/robots.txt"), "robots.txt");
  assert.equal(publicRelativePath("/sitemap.xml"), "sitemap.xml");
  assert.match(readFileSync("scripts/prepare-static.mjs", "utf8"), /"robots\.txt", "sitemap\.xml"/);
});
