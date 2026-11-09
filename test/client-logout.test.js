import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

function createDocument() {
  class El {
    constructor(tag) {
      this.tagName = tag.toUpperCase();
      this.children = [];
      this.attrs = {};
      this.className = "";
      this.hidden = false;
      this.id = "";
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
    register(id, tag) {
      const node = document.createElement(tag);
      node.id = id;
      return node;
    },
  };
  document.register("access-form", "div");
  document.register("project-code", "input");
  document.register("form-error", "p");
  document.register("project", "div");
  document.register("gate", "div");
  document.register("page-title", "h1");
  document.register("page-kicker", "p");
  document.register("status", "p");
  document.register("access-submit", "button");
  return { document, nodes };
}

const project = JSON.parse(readFileSync("fixtures/demo/project.json", "utf8"));

async function bootWith(fetchImpl) {
  const { document } = createDocument();
  const context = { document, URL, fetch: fetchImpl, globalThis: {} };
  vm.createContext(context);
  context.globalThis = context;
  vm.runInContext(readFileSync("js/view.js", "utf8"), context);
  await new Promise((resolve) => setTimeout(resolve, 20));
  return document;
}

test("a session shows the project and there is no leave button", async () => {
  const document = await bootWith(async (url) => {
    if (url === "/api/session") {
      return {
        ok: true,
        status: 200,
        json: async () => ({ authenticated: true, project }),
      };
    }
    throw new Error("unexpected request");
  });
  assert.equal(document.getElementById("gate").hidden, true);
  assert.equal(document.getElementById("project").hidden, false);
  assert.equal(document.getElementById("leave-project"), null);

  const reloaded = await bootWith(async (url) => {
    if (url === "/api/session") {
      return { ok: true, status: 200, json: async () => ({ authenticated: true, project }) };
    }
    throw new Error("unexpected request");
  });
  assert.equal(reloaded.getElementById("project").hidden, false);
  assert.equal(reloaded.getElementById("gate").hidden, true);
});
