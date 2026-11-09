import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

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
      this.tabIndex = 0;
      this.open = false;
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
    querySelector(selector) {
      const id = selector.startsWith("#") ? selector.slice(1) : "";
      const walk = (node) => {
        if (id && node.id === id) return node;
        for (const child of node.children || []) {
          const found = walk(child);
          if (found) return found;
        }
        return null;
      };
      return walk(this);
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
  const title = document.createElement("h1");
  title.id = "page-title";
  const subtitle = document.createElement("p");
  subtitle.id = "page-subtitle";
  subtitle.hidden = true;
  const root = document.createElement("div");
  context.projectView.renderProject(root, project);
  return { root, nodes, context };
}

test("a heavy project uses four tabs and shows one panel", () => {
  const project = JSON.parse(readFileSync("fixtures/demo/project.json", "utf8"));
  const { nodes } = boot(project);
  const tabs = nodes.filter((node) => node.attrs.role === "tab");
  const panels = nodes.filter((node) => node.attrs.role === "tabpanel");
  assert.deepEqual(tabs.map((tab) => tab.textContent), ["Overview", "Sections", "Drawings", "Model & files"]);
  assert.equal(panels.filter((panel) => !panel.hidden).length, 1);
  assert.equal(nodes.filter((node) => node.tagName === "DETAILS").length >= 8, true);
  const open = nodes.find((node) => node.className === "open-widget");
  assert.match(String(open.href || ""), /\/widgets\/sketch\/open$/);
  tabs[1].listeners.find((listener) => listener.type === "click").fn();
  assert.equal(panels.filter((panel) => !panel.hidden).length, 1);
  assert.equal(panels[1].hidden, false);
  const css = readFileSync("css/portal.css", "utf8");
  assert.match(css, /a\.open-widget:hover[\s\S]*color:\s*#faf9f6/);
  assert.match(css, /\.project-tab\[aria-selected="true"\]:hover[\s\S]*color:\s*#faf9f6/);
  assert.match(css, /#page-title\s*\{[^}]*font-size:\s*1\.75rem/);
  assert.match(css, /\.section-prose\s*\{[^}]*max-width:\s*38rem/);
  const cards = nodes.filter((node) => node.className === "section-card");
  assert.equal(cards.length >= 8, true);
  assert.equal(cards[0].open, true);
  assert.equal(cards[1].open, false);
  assert.equal(nodes.find((node) => node.id === "page-title").textContent, "Northglass Reading Room");
  const subtitle = nodes.find((node) => node.id === "page-subtitle");
  assert.equal(subtitle.hidden, false);
  assert.equal(subtitle.textContent, "Fictional demo for private viewing, not a client project");
  const openCard = nodes.find((node) => node.id === "s-option-a");
  assert.equal(openCard.children.some((node) => node.tagName === "SUMMARY"), true);
  assert.equal(openCard.textContent.includes("Nothing here is a real client"), true);
  assert.equal(openCard.textContent.includes("36\""), true);
  assert.equal(openCard.textContent.includes("9'-0\""), true);
  assert.equal(openCard.textContent.includes("3'-0\" x 4'-0\""), true);
  assert.equal(nodes.some((node) => node.tagName === "H3" && node.textContent === "West wall"), true);
  assert.equal(nodes.some((node) => node.tagName === "UL"), true);
  assert.equal(nodes.some((node) => node.className === "label" && node.textContent === "West wall:"), true);
  assert.equal(nodes.some((node) => node.className === "spec" && node.textContent === "36\""), true);
  const collapsed = nodes.find((node) => node.id === "s-option-b");
  const authored = collapsed.children[0].children.find((node) => node.className === "section-card-line");
  assert.equal(authored.textContent, "Invented glazed wall, roof, and window detail.");
  assert.equal(authored.attrs["data-generated"], undefined);
  assert.equal(collapsed.textContent.includes("Another invented paragraph"), true);
  const generated = nodes.find((node) => node.id === "s-option-h").children[0].children.find((node) => node.className === "section-card-line");
  assert.equal(generated.attrs["data-generated"], "true");
  assert.match(generated.textContent, /Eighth invented section/);
});

test("3D preview snapshots stay with the model files, not the drawings", () => {
  const project = {
    id: "demo-northglass",
    title: "Synthetic viewing project",
    summary: "A fictional summary used only to check tab grouping.",
    fictional: true,
    sections: [
      { id: "overview", title: "Overview", blocks: [{ type: "text", text: "Short fictional overview." }] },
      {
        id: "role-3d-preview",
        title: "3D preview",
        blocks: [{ type: "gallery", images: [{ mediaId: "plan", alt: "Fictional model snapshot", caption: "Fictional snapshot caption" }] }],
      },
      {
        id: "role-plan-sheet",
        title: "Plan sheet",
        blocks: [{ type: "gallery", images: [{ mediaId: "section", alt: "Fictional plan", caption: "Fictional plan caption" }] }],
      },
      {
        id: "role-downloadable-pdf",
        title: "PDF",
        blocks: [{ type: "attachment", attachmentId: "notes" }],
      },
    ],
    attachments: [{ id: "notes", label: "Fictional notes", kind: "file", mediaId: "notes", filename: "notes.pdf" }],
  };
  const { nodes } = boot(project);
  const drawings = nodes.find((node) => node.id === "panel-drawings");
  const files = nodes.find((node) => node.id === "panel-files");
  assert.equal(drawings.textContent.includes("3D preview"), false);
  assert.equal(drawings.textContent.includes("Fictional snapshot caption"), false);
  assert.equal(drawings.textContent.includes("Plan sheet"), true);
  assert.equal(files.textContent.includes("3D preview"), true);
  assert.equal(files.textContent.includes("Fictional snapshot caption"), true);
  const download = nodes.find((node) => node.tagName === "A" && String(node.href || "").includes("/attachments/notes"));
  assert.ok(download);
  assert.equal(nodes.find((node) => node.id === "page-subtitle").hidden, true);
});

test("section text becomes lists and headings without accepting HTML", () => {
  const hostile = [
    "## West wall",
    "",
    "- West wall: <img src=x onerror=alert(1)> beside a 36\" shelf.",
    "- North wall: a 15'-7\" x 12'-2 1/2\" invented opening, plus 3'x4', ~15\", and +11\".",
    "",
    "Model M-101 stays a name. **<script>alert(1)</script>** is still text. This sentence is here so the section is long enough to land on the Sections tab instead of the overview. The second sentence keeps the whole note in that tab.",
  ].join("\n");
  const project = {
    id: "demo-northglass",
    title: "<script>alert(1)</script>",
    summary: "Synthetic summary.",
    fictional: true,
    sections: [{ id: "walls", title: "Walls <script>", blocks: [{ type: "text", text: hostile }] }],
    attachments: [],
  };
  const { root, nodes, context } = boot(project);
  assert.equal(nodes.some((node) => node.tagName === "SCRIPT" || node.tagName === "IMG"), false);
  assert.equal(root.textContent.includes("<img src=x onerror=alert(1)>"), true);
  assert.equal(root.textContent.includes("<script>alert(1)</script>"), true);
  assert.equal(nodes.find((node) => node.id === "page-title").textContent, "<script>alert(1)</script>");
  const specs = nodes.filter((node) => (node.className || "").split(/\s+/).includes("spec")).map((node) => node.textContent);
  assert.equal(specs.includes("36\""), true);
  assert.equal(specs.includes("15'-7\" x 12'-2 1/2\""), true);
  assert.equal(specs.includes("3'x4'"), true);
  assert.equal(specs.includes("~15\""), true);
  assert.equal(specs.includes("+11\""), true);
  assert.equal(specs.includes("M-101"), false);
  const parsed = context.projectView.parseSectionText(hostile);
  assert.equal(parsed[0].type, "heading");
  assert.equal(parsed[0].text, "West wall");
  assert.equal(parsed[1].type, "list");
  assert.equal(parsed[1].items.length, 2);
  assert.equal(parsed.some((block) => block.type === "paragraph"), true);
  const flat = parsed.flatMap((block) => {
    if (block.type === "heading") return [block.text];
    if (block.type === "list") return block.items.flat().map((part) => part.text);
    return block.inlines.map((part) => part.text);
  }).join("");
  const keep = (value) => value.replace(/\*\*/g, "").replace(/^#{2,3}\s+/gm, "").replace(/^\s*[-*•]\s+/gm, "").replace(/\s+/g, "");
  assert.equal(keep(flat), keep(hostile));
});
