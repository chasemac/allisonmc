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
  const root = document.createElement("div");
  context.projectView.renderProject(root, project);
  return { root, nodes };
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
  const css = readFileSync("css/styles.css", "utf8");
  assert.match(css, /a\.open-widget:hover[\s\S]*color:\s*#f6f1e8/);
  assert.match(css, /\.project-tab\[aria-selected="true"\]:hover[\s\S]*color:\s*#f6f1e8/);
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
});
