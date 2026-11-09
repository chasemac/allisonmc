import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { mapSubmission } from "../lib/content-policy.js";
import { SchemaError } from "../lib/errors.js";
import { validatePresentation } from "../lib/schema.js";

const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082",
  "hex",
);

function image(name) {
  return { kind: "image", filename: name, bytes: PNG, contentType: "image/png" };
}

function submission(extra = {}) {
  return {
    projectId: "proj_example_001",
    submissionId: "sub_example_001",
    title: "Short title",
    client: "Synthetic client",
    location: "Synthetic place",
    preparedBy: "Synthetic author",
    date: "2026-01-01",
    notesForReviewers: "Synthetic reviewer note.",
    content: {
      summary: "Synthetic summary for a private viewing test.",
      sections: [{ id: "overview", heading: "Overview", body: "Synthetic section body that stays plain text." }],
    },
    assets: [],
    ...extra,
  };
}

function flowProject() {
  return {
    id: "demo-northglass",
    title: "Northglass Reading Room",
    summary: "Synthetic summary.",
    fictional: true,
    sections: [
      {
        id: "overview",
        title: "Overview",
        blocks: [{ type: "text", text: "Short fictional overview for the tab check." }],
      },
      {
        id: "concept-page",
        title: "Fictional concept page",
        kicker: "Invented package",
        blocks: [{
          type: "flow",
          blocks: [
            { type: "heading", level: 2, text: "Invented west wall" },
            { type: "paragraph", text: "A 36\" shelf stays text. <script>alert(1)</script> stays text." },
            { type: "list", ordered: false, items: ["West wall: a 9'-0\" bench."] },
            { type: "list", ordered: true, items: ["Confirm the aisle.", "Leave the east side open."] },
            {
              type: "table",
              caption: "Invented sizes",
              columns: ["Item", "Size"],
              rows: [["Shelf", "36\""], ["Window", "3'-0\" x 4'-0\""]],
            },
            { type: "callout", label: "Note", text: "Nothing here is a real measurement." },
            { type: "figure", mediaId: "plan", alt: "Fictional plan", caption: "Fictional plan caption" },
            { type: "source", mediaId: "detail", alt: "Fictional original page", label: "View original page" },
          ],
        }],
      },
    ],
    attachments: [],
  };
}

test("a flow block is accepted and unknown flow shapes are rejected", () => {
  const clean = validatePresentation(flowProject());
  const flow = clean.sections.find((section) => section.id === "concept-page").blocks[0];
  assert.equal(flow.type, "flow");
  assert.equal(flow.blocks[4].type, "table");
  assert.equal(flow.blocks[6].mediaId, "plan");
  assert.equal(clean.sections.find((section) => section.id === "concept-page").kicker, "Invented package");

  const base = flowProject();
  const replace = (blocks) => validatePresentation({
    ...base,
    sections: [{ id: "concept-page", title: "Page", blocks: [{ type: "flow", blocks }] }],
  });
  assert.throws(() => replace([{ type: "html", html: "<script>alert(1)</script>" }]), /unsupported flow block/);
  assert.throws(() => replace([{ type: "heading", level: 1, text: "Too high" }]), /heading level/);
  assert.throws(() => replace([{ type: "heading", level: 2, text: "Ok", extra: true }]), /unexpected field/);
  assert.throws(() => replace([{ type: "paragraph", text: "" }]), /text length/);
  assert.throws(() => replace([{ type: "list", ordered: "yes", items: ["One"] }]), /list/);
  assert.throws(() => replace([{ type: "list", ordered: false, items: [] }]), /list/);
  assert.throws(() => replace([{
    type: "table",
    columns: ["A", "B"],
    rows: [["only one"]],
  }]), /table/);
  assert.throws(() => replace([{ type: "figure", mediaId: "../plan", alt: "Alt" }]), /figure id/);
  assert.throws(() => replace([{ type: "source", mediaId: "detail", label: "View original page" }]), /expected text/);
  assert.throws(() => replace(Array.from({ length: 81 }, () => ({ type: "paragraph", text: "Row." }))), /flow/);
  assert.throws(() => validatePresentation({
    ...base,
    sections: [{ id: "concept-page", title: "Page", kicker: " ", blocks: [{ type: "text", text: "Still here." }] }],
  }), /text length/);
});

test("documents map onto Drawings and older submissions stay plain text", () => {
  const plain = mapSubmission(submission(), new Map());
  assert.equal(plain.presentation.sections.some((section) => section.blocks.some((block) => block.type === "flow")), false);
  const overview = plain.presentation.sections.find((section) => section.id === "overview");
  assert.equal(overview.blocks[0].text, "Synthetic section body that stays plain text.");

  const files = new Map([
    ["assets/hero.png", image("hero.png")],
    ["assets/plan.png", image("plan.png")],
    ["assets/page.png", image("page.png")],
  ]);
  const mapped = mapSubmission(submission({
    assets: [
      { path: "assets/hero.png", role: "hero", note: "Synthetic hero" },
      { path: "assets/plan.png", role: "figure", note: "Synthetic figure" },
      { path: "assets/page.png", role: "source-page", note: "Synthetic original page" },
    ],
    content: {
      summary: "Synthetic summary for a private viewing test.",
      sections: [{ id: "overview", heading: "Overview", body: "Synthetic section body that stays plain text." }],
      documents: [{
        id: "concept-p1",
        heading: "Synthetic concept page",
        kicker: "Package",
        summary: "One invented page.",
        blocks: [
          { type: "heading", level: 2, text: "At a glance" },
          { type: "paragraph", text: "East side open." },
          { type: "figure", path: "assets/plan.png", alt: "Synthetic plan drawing", caption: "Plan caption" },
          { type: "source", path: "assets/page.png", alt: "Original synthetic page", label: "View original page" },
        ],
      }],
    },
  }), files);
  const ids = mapped.presentation.sections.map((section) => section.id);
  assert.deepEqual(ids, ["meta-details", "overview", "meta-notes", "role-hero", "concept-p1"]);
  const doc = mapped.presentation.sections.find((section) => section.id === "concept-p1");
  assert.equal(doc.kicker, "Package");
  assert.equal(doc.summary, "One invented page.");
  assert.equal(doc.blocks[0].type, "flow");
  assert.equal(doc.blocks[0].blocks[2].mediaId, "plan");
  assert.equal(doc.blocks[0].blocks[2].path, undefined);
  assert.deepEqual(mapped.warnings, []);
  assert.equal(mapped.presentation.sections.some((section) => section.id === "role-figure"), false);
  assert.equal(mapped.presentation.sections.some((section) => section.id === "role-source-page"), false);
  assert.equal(overviewStill(mapped), "Synthetic section body that stays plain text.");

  assert.throws(() => mapSubmission(submission({
    content: {
      summary: "Synthetic summary for a private viewing test.",
      sections: [{ id: "overview", heading: "Overview", body: "Synthetic section body that stays plain text." }],
      documents: [{ id: "concept-p1", heading: "Page", blocks: [{ type: "paragraph", text: "Text." }], lede: "no" }],
    },
  }), new Map()), /unexpected document field/);
  assert.throws(() => mapSubmission(submission({
    assets: [{ path: "assets/plan.png", role: "figure", note: "Synthetic figure" }],
    content: {
      summary: "Synthetic summary for a private viewing test.",
      sections: [{ id: "overview", heading: "Overview", body: "Synthetic section body that stays plain text." }],
      documents: [{ id: "concept-p1", heading: "Page", blocks: [{ type: "paragraph", text: "No figure here." }] }],
    },
  }), new Map([["assets/plan.png", image("plan.png")]])), /unreferenced inline asset/);
  assert.throws(() => mapSubmission(submission({
    assets: [{ path: "assets/plan.png", role: "gallery", note: "Synthetic gallery" }],
    content: {
      summary: "Synthetic summary for a private viewing test.",
      sections: [{ id: "overview", heading: "Overview", body: "Synthetic section body that stays plain text." }],
      documents: [{
        id: "concept-p1",
        heading: "Page",
        blocks: [{ type: "figure", path: "assets/plan.png", alt: "Wrong role" }],
      }],
    },
  }), new Map([["assets/plan.png", image("plan.png")]])), /asset role does not match block/);
  assert.throws(() => mapSubmission(submission({
    content: {
      summary: "Synthetic summary for a private viewing test.",
      sections: [{ id: "overview", heading: "Overview", body: "Synthetic section body that stays plain text." }],
      documents: [{ id: "concept-p1", heading: "Page", blocks: [{ type: "widget", mediaId: "plan" }] }],
    },
  }), new Map()), /unsupported flow block/);
  assert.throws(() => mapSubmission(submission({
    content: {
      summary: "Synthetic summary for a private viewing test.",
      sections: [{ id: "overview", heading: "Overview", body: "Body.", blocks: [] }],
    },
  }), new Map()), /unexpected section field/);
  assert.throws(() => mapSubmission(submission({
    content: {
      summary: "Synthetic summary for a private viewing test.",
      sections: [{ id: "overview", heading: "Overview", body: "Synthetic section body that stays plain text." }],
      documents: [{
        id: "concept-p1",
        heading: "Page",
        blocks: [{ type: "paragraph", text: "Text.", html: "<b>no</b>" }],
      }],
    },
  }), new Map()), (err) => err instanceof SchemaError && err.message === "unexpected flow field");
  assert.throws(() => mapSubmission(submission({
    content: {
      summary: "Synthetic summary for a private viewing test.",
      sections: [{ id: "overview", heading: "Overview", body: "Synthetic section body that stays plain text." }],
      documents: [{
        id: "concept-p1",
        heading: "Page",
        blocks: [{ type: "list", ordered: false, items: ["One"], extra: true }],
      }],
    },
  }), new Map()), /unexpected flow field/);
});

function overviewStill(mapped) {
  return mapped.presentation.sections.find((section) => section.id === "overview").blocks[0].text;
}

function boot(project) {
  class El {
    constructor(tag) {
      this.tagName = tag.toUpperCase();
      this.children = [];
      this.attrs = {};
      this.hidden = false;
      this.id = "";
      this.className = "";
      this.listeners = [];
    }
    set textContent(value) {
      this.stored = value == null ? "" : String(value);
      this.children = [];
    }
    get textContent() {
      if (this.children.length === 0) return this.stored || "";
      return this.children.map((child) => child.textContent || "").join("");
    }
    append(...nodes) {
      this.stored = "";
      this.children.push(...nodes);
    }
    setAttribute(name, value) {
      this.attrs[name] = String(value);
      if (name === "id") this.id = String(value);
    }
    getAttribute(name) {
      return this.attrs[name];
    }
    addEventListener(type, fn) {
      this.listeners.push({ type, fn });
    }
    focus() {}
    querySelector() {
      return null;
    }
  }
  const nodes = [];
  const document = {
    createElement: (tag) => {
      const node = new El(tag);
      nodes.push(node);
      return node;
    },
    getElementById(id) {
      return nodes.find((node) => node.id === id) || null;
    },
    activeElement: null,
  };
  const context = { document, URL, globalThis: {} };
  vm.createContext(context);
  context.globalThis = context;
  vm.runInContext(readFileSync("js/view.js", "utf8"), context);
  const root = document.createElement("div");
  context.projectView.renderProject(root, project);
  return { root, nodes };
}

test("the demo fixture still renders, and a concept flow stays on Drawings", () => {
  const demo = validatePresentation(JSON.parse(readFileSync("fixtures/demo/project.json", "utf8")));
  assert.equal(demo.fictional, true);
  assert.equal(demo.sections.some((section) => section.blocks.some((block) => block.type === "flow")), true);
  const { nodes } = boot(demo);
  const drawings = nodes.find((node) => node.id === "panel-drawings");
  const sections = nodes.find((node) => node.id === "panel-sections");
  assert.equal(drawings.textContent.includes("Invented sizes"), true);
  assert.equal(drawings.textContent.includes("Fictional plan, shown inside the page"), true);
  assert.equal(drawings.textContent.includes("View original page"), true);
  assert.equal(sections.textContent.includes("Invented sizes"), false);
  assert.equal(nodes.some((node) => node.tagName === "SCRIPT"), false);
});

test("flow HTML is built with text nodes, resolved figures, and a scrolling table", () => {
  const source = readFileSync("js/view.js", "utf8");
  assert.equal(source.includes("innerHTML"), false);
  assert.equal(source.includes("insertAdjacentHTML"), false);
  assert.equal(source.includes("outerHTML"), false);
  const { nodes } = boot(flowProject());
  assert.equal(nodes.some((node) => node.tagName === "SCRIPT"), false);
  assert.equal(nodes.some((node) => node.textContent.includes("<script>alert(1)</script>")), true);
  const image = nodes.find((node) => node.tagName === "IMG" && node.src && node.src.includes("/media/plan"));
  assert.ok(image);
  assert.equal(image.loading, "lazy");
  assert.equal(image.alt, "Fictional plan");
  const zoom = nodes.find((node) => node.className === "flow-zoom" && node.attrs["aria-label"] === "Expand image: Fictional plan");
  assert.equal(zoom.listeners.some((listener) => listener.type === "click"), true);
  assert.equal(nodes.some((node) => node.tagName === "OL"), true);
  assert.equal(nodes.some((node) => node.tagName === "UL"), true);
  const cell = nodes.find((node) => node.tagName === "TD" && node.attrs["data-label"] === "Size");
  assert.equal(cell.textContent, "36\"");
  const sourceImage = nodes.find((node) => node.tagName === "IMG" && node.src && node.src.includes("/media/detail"));
  assert.equal(sourceImage.loading, "lazy");
  const drawings = nodes.find((node) => node.id === "panel-drawings");
  const sections = nodes.find((node) => node.id === "panel-sections");
  assert.equal(drawings.textContent.includes("Invented west wall"), true);
  assert.equal(sections ? sections.textContent.includes("Invented west wall") : false, false);
  const css = readFileSync("css/styles.css", "utf8");
  assert.match(css, /\.flow-table-wrap\s*\{[^}]*overflow-x:\s*auto/);
  assert.match(css, /\.flow-zoom img\s*\{[^}]*width:\s*auto/);
  assert.match(css, /\.flow-table td::before\s*\{[^}]*content:\s*attr\(data-label\)/);
  assert.match(css, /@media \(max-width: 799px\)[\s\S]*\.flow-table caption\s*\{[^}]*display:\s*block/);
  assert.match(css, /--font:\s*"Lato"/);
});
