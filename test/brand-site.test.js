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
    assert.deepEqual([...nav.matchAll(/<a [^>]*>([^<]+)<\/a>/g)].map((m) => m[1]), ["Work", "Services", "About", "Stories", "Inquire", "Start a Project"], page);
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
    "McElroy Bathroom",
    "Buckner Camp Kitchen",
    "Begin with the level of help you actually need.",
    "Our Costa Mesa Home, in Phases",
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
  assert.match(html, /<p class="status">Concept design<\/p>/);
});

test("photos are labeled placeholders with the photo guide IDs, never stock or AI images", () => {
  const expected = {
    "index.html": ["K-01", "B-01", "K-07", "A-01"],
    "work-mcelroy-kitchen.html": ["K-01", "K-02", "K-03", "K-04", "K-05", "K-07", "K-08"],
    "work-mcelroy-bathroom.html": ["B-01", "B-02", "B-03", "B-04", "B-05", "B-06"],
    "about.html": ["A-01", "C-01"],
  };
  for (const [page, ids] of Object.entries(expected)) {
    const html = read(page);
    for (const id of ids) assert.match(html, new RegExp(`\\[PHOTO: ${id}\\]`), `${page} ${id}`);
  }
  assert.match(read("work-mcelroy-kitchen.html"), /During the renovation/);
  assert.match(read("work-mcelroy-kitchen.html"), /<span class="ph-label">Before<\/span>/);
  for (const page of SITE_PAGES) {
    for (const img of read(page).match(/<img\b[^>]*>/g) || []) {
      assert.match(img, /src="assets\/img\/wordmark-/, `${page} has a non-logo image: ${img}`);
    }
  }
});

test("open facts stay visible placeholders instead of guesses", () => {
  const all = SITE_PAGES.map(read).join("\n");
  for (const marker of [
    "CONFIRM PUBLIC PERMISSION AND STATUS WORDING FOR BUCKNER CAMP",
    "SERVICE DELIVERY AND SCHEDULING DETAILS TO BE CONFIRMED WITH BRENDA",
    "BRENDA TO APPROVE COPY, PHOTO, SERVICE AREA AND DELIVERY MODEL",
    "CONFIRM EXACT GENSLER ROLE AND PROJECT EXPERIENCE BEFORE PUBLISHING",
    "CONFIRM WHICH SERVICES ARE FULLY REMOTE",
    "BUDGET RANGES TO BE ADDED ONLY AFTER ALLISON CONFIRMS THEM",
    "INSTAGRAM LINK TO CONFIRM",
  ]) {
    assert.equal(all.includes(marker), true, marker);
  }
  assert.equal(/\$\s?\d/.test(visible(all)), false, "no prices");
  assert.equal(/testimonial|award/i.test(visible(all)), false);
  assert.equal(all.includes("organizedbychoice.com"), false, "no collaborator link before Brenda approves");
  assert.equal(/Gensler/.test(visible(all).replace(/\[[^\]]*GENSLER[^\]]*\]/g, "")), false);
});

test("Buckner Camp stays a concept card with no public image or private link", () => {
  for (const page of ["index.html", "work.html"]) {
    const html = read(page);
    const card = html.slice(html.indexOf("Buckner Camp Kitchen") - 600, html.indexOf("Buckner Camp Kitchen") + 600);
    assert.match(card, /Concept design/);
    assert.equal(/<img|view\.html|proj_buckner/.test(card), false, page);
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
  assert.match(form, /data-inquiry-email=""/);
  assert.match(html, /id="inquiry-submit" disabled/);
  assert.match(html, /<script src="js\/inquire\.js" defer><\/script>/);
  const js = read("js/inquire.js");
  assert.equal(/fetch\(|XMLHttpRequest|sendBeacon|innerHTML/.test(js), false);
  assert.match(js, /mailto:/);
  for (const id of html.matchAll(/<label for="([^"]+)"/g)) assert.match(html, new RegExp(`id="${id[1]}"`));
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
