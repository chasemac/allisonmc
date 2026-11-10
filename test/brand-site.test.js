import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { LEGACY_PAGES, SITE_PAGES } from "../scripts/pages.mjs";

// Allison's brand toolkit and website brief (Nov 9, 2026).
const read = (file) => readFileSync(file, "utf8");
const text = (html) => html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const visible = (html) => text(html.replace(/<head>[\s\S]*?<\/head>/, ""));

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

test("the site uses the Evergreen + Slate palette with readable text", () => {
  const css = read("css/site.css");
  const token = (name) => css.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`))[1];
  assert.deepEqual(
    ["soft-white", "ivory", "mist", "sea-glass", "slate", "pine", "ink"].map(token),
    ["#faf9f6", "#f3efe7", "#dce7e7", "#afc9bf", "#3e6377", "#274c43", "#26343a"],
  );
  for (const bg of ["soft-white", "ivory", "mist"]) {
    assert.ok(contrast(token("ink"), token(bg)) >= 7, `ink on ${bg}`);
    assert.ok(contrast(token("slate"), token(bg)) >= 4.5, `slate on ${bg}`);
    assert.ok(contrast(token("pine"), token(bg)) >= 4.5, `pine on ${bg}`);
    assert.ok(contrast(token("muted"), token(bg)) >= 4.5, `muted on ${bg}`);
  }
  assert.ok(contrast(token("soft-white"), token("pine")) >= 7, "soft white on pine");
  assert.ok(contrast(token("mist"), token("pine")) >= 4.5, "mist on pine");
  assert.match(css, /:focus-visible/);
  assert.match(css, /prefers-reduced-motion/);
});

test("every designer page has the nav, the header wordmark, the CTA and the delivery lines", () => {
  for (const page of SITE_PAGES) {
    const html = read(page);
    assert.match(html, /<link href="css\/site\.css" rel="stylesheet" \/>/, page);
    assert.equal(html.includes("css/styles.css"), false, page);
    const nav = html.match(/<ul id="primary-nav">([\s\S]*?)<\/ul>/)[1];
    assert.deepEqual([...nav.matchAll(/<a [^>]*>([^<]+)<\/a>/g)].map((m) => m[1]), ["Work", "Services", "About", "Inquire", "Start a Project"], page);
    assert.match(html, /wordmark-horizontal-black-800\.png" width="800" height="169" alt="Allison McElroy Design, home"/, page);
    assert.match(html, /wordmark-stacked-white-960\.png/, page);
    for (const line of ["Based in Costa Mesa, California", "Serving Orange County in person", "Select services available remotely"]) {
      assert.equal(html.includes(line), true, `${page}: ${line}`);
    }
    assert.match(html, /<a href="view\.html">Client project access<\/a>/, page);
    assert.equal(/musings|legacy-home|Blog|Shop|Handmade/.test(visible(html)), false, page);
  }
});

test("the copy follows the voice rules", () => {
  for (const page of SITE_PAGES) {
    const words = visible(read(page));
    assert.equal(/coastal|beach|seaside|shore|ocean|California-cool|luxury|bespoke|curated|elevated|transformational|dream home|chaos|limited spots/i.test(words), false, page);
    assert.equal(/\b(an|the|licensed) architect\b|architect,|Architect\b|Certified Professional Organizer|Certified Interior Designer|contractor services/i.test(words), false, page);
  }
  const descriptor = "Allison McElroy is a designer with a master’s in architecture, with professional architecture and marketing experience.";
  assert.equal(read("about.html").includes(descriptor), true);
  assert.equal(read("index.html").includes(descriptor), true);
});

test("the homepage follows the blueprint order and copy", () => {
  const html = read("index.html");
  const order = [
    "Timeless homes, designed for real life.",
    "Based in Costa Mesa, serving Orange County in person, with select services available remotely.",
    "Start with what is already there.",
    "Selected Work",
    "McElroy Kitchen",
    "Begin with the level of help you actually need.",
    "Modern by training. Timeless by conviction.",
    "Not sure whether you need decorating, organizing or a renovation?",
  ];
  let at = 0;
  for (const phrase of order) {
    const next = html.indexOf(phrase, at);
    assert.ok(next >= 0, `missing or out of order: ${phrase}`);
    at = next;
  }
  assert.match(html, /<h1>Timeless homes, designed for real life\.<\/h1>/);
  assert.match(html, /href="inquire\.html">Start a Project<\/a><a class="button button-quiet" href="services\.html">Explore Services<\/a>/);
  assert.match(html, /<p class="status">Completed 2025<\/p>/);
  assert.equal(html.includes("Buckner Camp"), false);
});

test("photo slots show the chosen McElroy photos, never placeholders, stock or AI images", () => {
  const photos = {
    "index.html": ["K-01"],
    "work.html": ["K-01"],
    "work-mcelroy-kitchen.html": ["K-01", "K-02", "K-03", "K-04", "K-05"],
  };
  for (const [page, ids] of Object.entries(photos)) {
    const html = read(page);
    for (const id of ids) {
      assert.match(html, new RegExp(`<figure class="photo [^"]+" data-photo="${id}">`), `${page} ${id} photo`);
      assert.equal(html.includes(`[PHOTO: ${id}]`), false, `${page} ${id} still a placeholder`);
    }
  }
  for (const page of SITE_PAGES) {
    const html = read(page);
    assert.equal(/\[PHOTO:/.test(html), false, `${page} still has a photo placeholder`);
    assert.equal(html.includes('class="ph ') || html.includes("class='ph "), false, `${page} still has a placeholder frame`);
    assert.equal(html.includes("ph-frame"), false, `${page} still has a placeholder frame`);
  }
  // A-01 is Allison's portrait (supplied by Chase), on the homepage About band and the About page.
  for (const page of ["index.html", "about.html"]) {
    const html = read(page);
    assert.equal(html.includes("[PHOTO: A-01]"), false, `${page} A-01 still a placeholder`);
    assert.match(html, /data-photo="A-01">\s*<picture>[\s\S]*?src="assets\/img\/allison-a01-\d+\.jpg"[^>]*alt="Allison McElroy"/, `${page} A-01`);
  }
  for (const page of SITE_PAGES) {
    for (const img of read(page).match(/<img\b[^>]*>/g) || []) {
      assert.match(img, /src="assets\/img\/(wordmark-|kitchen-k0[1-5]|allison-a01)/, `${page} has an unexpected image: ${img}`);
      if (!/wordmark-/.test(img)) {
        assert.match(img, /alt="[^"]{10,}"|alt="Allison McElroy"/, `${page} photo needs alt text: ${img}`);
        assert.match(img, / width="\d+" height="\d+"/, `${page} photo needs dimensions: ${img}`);
      }
    }
  }
});

test("every referenced photo file exists and carries no EXIF or GPS block", () => {
  const refs = new Set();
  for (const page of SITE_PAGES) {
    for (const m of read(page).matchAll(/assets\/img\/((?:kitchen|allison)-[a-z0-9-]+\.(?:webp|jpg))/g)) refs.add(m[1]);
  }
  assert.ok(refs.size >= 10, `found ${refs.size} photo files`);
  for (const f of refs) {
    const buf = readFileSync(`assets/img/${f}`);
    assert.equal(buf.includes(Buffer.from("Exif\0\0")), false, `${f} has EXIF`);
    assert.equal(buf.includes(Buffer.from("EXIF")), false, `${f} has a WebP EXIF chunk`);
  }
});

test("open facts are omitted from public pages instead of being guessed", () => {
  const all = SITE_PAGES.map(read).join("\n");
  for (const marker of [
    "CONFIRM PUBLIC PERMISSION AND STATUS WORDING FOR BUCKNER CAMP",
    "SERVICE DELIVERY AND SCHEDULING DETAILS TO BE CONFIRMED WITH BRENDA",
    "BRENDA TO APPROVE COPY, PHOTO, SERVICE AREA AND DELIVERY MODEL",
    "CONFIRM EXACT GENSLER ROLE AND PROJECT EXPERIENCE BEFORE PUBLISHING",
    "CONFIRM WHICH SERVICES ARE FULLY REMOTE",
    "BUDGET RANGES TO BE ADDED ONLY AFTER ALLISON CONFIRMS THEM",
    "TO WRITE WITH ALLISON",
    "TO CONFIRM WITH ALLISON",
    "SERVICES PROVIDED TO CONFIRM",
    "PHOTOGRAPHER CREDIT, WHEN KNOWN",
    "INQUIRY EMAIL ADDRESS TO CONFIRM",
    "class=\"todo\"",
  ]) {
    assert.equal(all.includes(marker), false, marker);
  }
  assert.equal(/\$\s?\d/.test(visible(all)), false, "no prices");
  assert.equal(/testimonial|award/i.test(visible(all)), false);
  // Chase supplied Brenda's site, so Organized By Choice links out; unconfirmed delivery, travel and schedule details are omitted.
  for (const a of all.match(/<a [^>]*organizedbychoice\.com[^>]*>/g) || []) {
    assert.match(a, /href="https:\/\/www\.organizedbychoice\.com"/);
    assert.match(a, /rel="noopener noreferrer"/);
  }
  // Chase confirmed the Instagram profile, so the public footer links out instead of keeping a placeholder.
  const instagram = /<a href="https:\/\/www\.instagram\.com\/llison_mac\/" target="_blank" rel="noopener noreferrer">Instagram<span class="sr-only"> \(opens in a new tab\)<\/span><\/a>/;
  for (const page of [...SITE_PAGES, "view.html"]) {
    const html = read(page);
    assert.equal(html.includes("INSTAGRAM LINK TO CONFIRM"), false, page);
    assert.match(html, instagram, page);
  }
  assert.match(read("about.html"), /linkedin\.com\/in\/allisongaymcelroy\/[\s\S]*instagram\.com\/llison_mac\//);
  for (const page of ["services.html", "about.html", "index.html"]) {
    assert.match(read(page), /href="https:\/\/www\.organizedbychoice\.com"/, `${page} links Organized By Choice`);
  }
  assert.equal(/Gensler/.test(visible(all)), false);
});

test("Buckner Camp is not listed on public work pages until wording is confirmed", () => {
  for (const page of SITE_PAGES) {
    const html = read(page);
    assert.equal(/Buckner/i.test(html), false, page);
    assert.equal(/proj_buckner/.test(html), false, page);
  }
});

test("the inquiry form has the brief's fields and sends nothing from the site", () => {
  const html = read("inquire.html");
  for (const label of [
    "Name", "Email", "Phone", "Project location",
    "Are you seeking in-person help in Orange County, remote help, or are you not sure yet?",
    "What kind of help are you considering?", "Which rooms?", "What do you already own or hope to keep?",
    "What is not working now?", "Ideal timing", "How did you hear about Allison McElroy Design?", "Anything else we should know?",
  ]) {
    assert.equal(html.includes(label), true, label);
  }
  for (const option of ["Home Refresh", "Color &amp; Materials", "Kitchen or Bath Design", "Organizing", "Not Sure Yet"]) {
    assert.equal(html.includes(`value="${option}"`), true, option);
  }
  const form = html.match(/<form\b[^>]*>/)[0];
  assert.equal(/\baction=|\bmethod=/.test(form), false, "no form post");
  assert.equal(/data-inquiry-email\s*=/.test(form), false);
  assert.match(html, /id="inquiry-status"/);
  assert.match(html, /id="inquiry-submit" disabled/);
  assert.match(html, /id="inquiry-panel"[^>]*hidden/);
  assert.equal(/Message on Instagram|send Allison a message on/i.test(html), false);
  assert.equal(html.includes("Tell us a little about your home"), false);
  assert.match(html, /<script src="js\/inquire\.js" defer><\/script>/);
  const js = read("js/inquire.js");
  assert.equal(/fetch\(|XMLHttpRequest|sendBeacon|innerHTML/.test(js), false);
  assert.match(js, /mailto:/);
  for (const id of html.matchAll(/<label for="([^"]+)"/g)) assert.match(html, new RegExp(`id="${id[1]}"`));
});

test("public pages do not include an email address", () => {
  const address = /[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}/i;
  const mailto = /mailto:\s*[^"'\s>]+/i;
  for (const page of [...SITE_PAGES, "view.html", ...LEGACY_PAGES]) {
    const html = read(page);
    assert.equal(address.test(html), false, `${page} has an email address`);
    assert.equal(mailto.test(html), false, `${page} has a mailto link`);
    for (const m of html.matchAll(/data-inquiry-email="([^"]*)"/g)) {
      assert.equal(m[1], "", `${page} data-inquiry-email must stay empty`);
    }
  }
});

test("hidden legacy pages are preserved, not linked and not indexed", () => {
  for (const page of LEGACY_PAGES) {
    assert.equal(existsSync(page), true, page);
    assert.match(read(page), /<meta name="robots" content="noindex" \/>/, page);
  }
  for (const page of SITE_PAGES) {
    assert.equal(/href="(musings|legacy-home)\.html"/.test(read(page)), false, page);
  }
});

test("the client project viewer wears the brand header, nav and footer and keeps its hooks", () => {
  const view = read("view.html");
  const about = read("about.html");
  const header = (html) => html.slice(html.indexOf('<header class="site-header">'), html.indexOf("</header>")).replace(/ aria-current="page"/g, "");
  assert.equal(header(view), header(about), "same header as the public pages");
  assert.match(view, /<footer class="site-footer">[\s\S]*wordmark-stacked-white/);
  assert.match(view, /<link href="css\/site\.css" rel="stylesheet" \/>\s*<link href="css\/portal\.css" rel="stylesheet" \/>/);
  assert.equal(view.includes("css/styles.css"), false);
  assert.equal(/musings|behance|Musings/i.test(view), false, "no old Musings or Behance links");
  assert.equal(/leave/i.test(visible(view)), false, "no Leave button");
  assert.match(view, /<meta name="robots" content="noindex" \/>/);
  for (const id of ["page-kicker", "page-title", "page-subtitle", "status", "gate", "access-hint", "access-form", "project-code", "access-submit", "form-error", "project", "lightbox"]) {
    assert.match(view, new RegExp(`id="${id}"`), id);
  }
  assert.match(view, /<script src="js\/view\.js"><\/script>/);
  const css = readFileSync("css/portal.css", "utf8");
  assert.equal(/^\s*(label|input|body|html|\.site-header|\.nav|\.site-footer)\b[^{]*\{/m.test(css), false, "portal.css leaves the shared header, nav, footer and bare elements to site.css");
});
