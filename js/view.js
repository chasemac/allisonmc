(function () {
  function isHttps(href) {
    try {
      const url = new URL(href);
      if (url.protocol !== "https:" || url.username || url.password) return "";
      return url.href;
    } catch {
      return "";
    }
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function safeId(value, pattern) {
    return typeof value === "string" && pattern.test(value) ? value : "";
  }

  const projectPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;
  const sectionPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
  const mediaPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;

  function renderGallery(projectId, images) {
    const gallery = el("ul", "gallery");
    const prepared = [];
    for (const image of images) {
      const mediaId = safeId(image && image.mediaId, mediaPattern);
      if (!mediaId || !safeId(projectId, projectPattern)) continue;
      const item = {
        src: `/api/projects/${projectId}/media/${mediaId}`,
        alt: String(image.alt || ""),
        caption: image.caption ? String(image.caption) : "",
      };
      const index = prepared.push(item) - 1;
      const listItem = el("li");
      const button = document.createElement("button");
      button.type = "button";
      const img = document.createElement("img");
      img.src = item.src;
      img.alt = item.alt;
      button.append(img);
      if (item.caption) button.append(el("span", "caption", item.caption));
      button.addEventListener("click", () => openLightbox(prepared, index));
      listItem.append(button);
      gallery.append(listItem);
    }
    return gallery;
  }

  function renderAttachment(projectId, attachment) {
    if (!attachment || !safeId(projectId, projectPattern)) return null;
    const item = el("p", "attachment");
    if (attachment.kind === "file" && safeId(attachment.id, mediaPattern)) {
      const link = el("a", "", String(attachment.label || "Download"));
      link.href = `/api/projects/${projectId}/attachments/${attachment.id}`;
      item.append(link);
      return item;
    }
    if (attachment.kind === "link") {
      const href = isHttps(attachment.href);
      if (!href) return null;
      const link = el("a", "", String(attachment.label || "Link"));
      link.href = href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.append(el("span", "sr-only", " (opens in a new tab)"));
      item.append(link);
      return item;
    }
    return null;
  }

  const TAB_DEFS = [
    { id: "overview", label: "Overview" },
    { id: "sections", label: "Sections" },
    { id: "drawings", label: "Drawings" },
    { id: "files", label: "Model & files" },
  ];

  function pageHash() {
    try {
      const raw = String(globalThis.location && location.hash ? location.hash : "").replace(/^#/, "");
      return /^[A-Za-z0-9_-]{1,80}$/.test(raw) ? raw : "";
    } catch {
      return "";
    }
  }

  function sectionTab(section) {
    const id = section.id || "";
    const blocks = Array.isArray(section.blocks) ? section.blocks : [];
    if (id === "meta-details" || id === "meta-notes" || id === "overview") return "overview";
    if (id === "role-3d-preview" || id === "3d-preview" || section.title === "3D preview") return "files";
    if (id.indexOf("role-") === 0) {
      const role = id.slice(5);
      if (["hero", "page-preview", "plan-sheet", "proposal-preview", "punchlist-preview", "reference-photo", "gallery"].indexOf(role) >= 0) {
        return "drawings";
      }
      return "files";
    }
    const types = blocks.map((block) => (block && block.type) || "");
    if (types.indexOf("flow") >= 0) return "drawings";
    if (types.indexOf("widget") >= 0) return "files";
    if (types.indexOf("gallery") >= 0) return "drawings";
    if (types.indexOf("attachment") >= 0) return "files";
    const text = blocks.map((block) => (block && block.type === "text" ? block.text : "")).join("");
    return text.length > 180 ? "sections" : "overview";
  }

  function specPattern() {
    return /(?:\+?~?)?(?:\d+'\s*-\s*\d+(?:\s+\d+\/\d+)?"|\d+'\s*x\s*\d+'|\d+(?:\s+\d+\/\d+)?")(?:\s*x\s*(?:\+?~?)?(?:\d+'\s*-\s*\d+(?:\s+\d+\/\d+)?"|\d+'\s*x\s*\d+'|\d+(?:\s+\d+\/\d+)?"))*/g;
  }

  function isBullet(line) {
    return /^\s*[-*•]\s+\S/.test(line);
  }

  function isSubheading(line) {
    return /^#{2,3}\s+\S/.test(String(line || "").trim());
  }

  function plainSyntax(value) {
    return String(value || "").replace(/\*\*([^*\n]+)\*\*/g, "$1").trim();
  }

  function splitLabel(value) {
    const match = /^([A-Za-z][^:\n]{0,39}):\s+/.exec(value);
    if (!match) return null;
    if (/[<>*]|https?:/i.test(match[1])) return null;
    return { label: match[1] + ":", rest: value.slice(match[0].length) };
  }

  function parseInlines(value) {
    const pieces = [];
    const bold = /\*\*([^*\n]{1,80})\*\*/g;
    let last = 0;
    let match;
    while ((match = bold.exec(value))) {
      if (match.index > last) pieces.push({ text: value.slice(last, match.index), bold: false });
      pieces.push({ text: match[1], bold: true });
      last = bold.lastIndex;
    }
    if (last < value.length) pieces.push({ text: value.slice(last), bold: false });
    if (!pieces.length) pieces.push({ text: value, bold: false });
    if (pieces[0] && !pieces[0].bold) {
      const labeled = splitLabel(pieces[0].text);
      if (labeled) {
        const replacement = [{ text: labeled.label, bold: true }];
        if (labeled.rest) replacement.push({ text: " " + labeled.rest, bold: false });
        pieces.splice(0, 1, ...replacement);
      }
    }
    const out = [];
    for (const piece of pieces) {
      const specs = specPattern();
      let cursor = 0;
      let spec;
      while ((spec = specs.exec(piece.text))) {
        if (spec.index > cursor) out.push({ text: piece.text.slice(cursor, spec.index), bold: piece.bold, spec: false });
        out.push({ text: spec[0], bold: piece.bold, spec: true });
        cursor = specs.lastIndex;
        if (!spec[0]) break;
      }
      if (cursor < piece.text.length) out.push({ text: piece.text.slice(cursor), bold: piece.bold, spec: false });
    }
    return out.filter((part) => part.text);
  }

  function chunkProse(value) {
    if (value.length <= 240) return [value];
    const parts = value.split(/(?<=[.!?])\s+(?=[A-Z"“])/);
    if (parts.length < 2) return [value];
    const chunks = [];
    let current = "";
    for (const part of parts) {
      const next = current ? current + " " + part : part;
      if (current && next.length > 220) {
        chunks.push(current);
        current = part;
      } else {
        current = next;
      }
    }
    if (current) chunks.push(current);
    return chunks;
  }

  function parseSectionText(raw) {
    const lines = String(raw == null ? "" : raw).replace(/\r\n/g, "\n").split("\n");
    const blocks = [];
    let index = 0;
    while (index < lines.length) {
      if (!lines[index].trim()) {
        index += 1;
        continue;
      }
      const heading = /^(#{2,3})\s+(\S.*)$/.exec(lines[index].trim());
      if (heading) {
        blocks.push({ type: "heading", text: plainSyntax(heading[2]) });
        index += 1;
        continue;
      }
      if (isBullet(lines[index])) {
        const items = [];
        while (index < lines.length && isBullet(lines[index])) {
          items.push(parseInlines(lines[index].replace(/^\s*[-*•]\s+/, "")));
          index += 1;
        }
        blocks.push({ type: "list", items });
        continue;
      }
      const para = [];
      while (index < lines.length && lines[index].trim() && !isSubheading(lines[index]) && !isBullet(lines[index])) {
        para.push(lines[index].trim());
        index += 1;
      }
      for (const chunk of chunkProse(para.join(" "))) {
        blocks.push({ type: "paragraph", inlines: parseInlines(chunk) });
      }
    }
    return blocks;
  }

  function inlineClass(part) {
    const names = [];
    if (part.bold) names.push("label");
    if (part.spec) names.push("spec");
    return names.join(" ");
  }

  function appendInlines(node, parts) {
    for (const part of parts) node.append(el("span", inlineClass(part), part.text));
  }

  function capAtSource(img) {
    img.addEventListener("load", () => {
      if (!img.naturalWidth || !img.style) return;
      img.style.maxWidth = "min(100%, " + img.naturalWidth + "px)";
    });
  }

  function mediaSrc(projectId, mediaId) {
    if (!safeId(mediaId, mediaPattern) || !safeId(projectId, projectPattern)) return "";
    return `/api/projects/${projectId}/media/${mediaId}`;
  }

  function zoomableImage(src, alt, onOpen) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "flow-zoom";
    button.setAttribute("aria-label", "Expand image: " + alt);
    const img = document.createElement("img");
    img.src = src;
    img.alt = alt;
    img.loading = "lazy";
    img.decoding = "async";
    capAtSource(img);
    button.append(img);
    button.addEventListener("click", onOpen);
    return button;
  }

  function renderFlow(projectId, flow) {
    const wrap = el("div", "flow");
    const blocks = Array.isArray(flow && flow.blocks) ? flow.blocks : [];
    const figures = [];
    for (const block of blocks) {
      if (!block || (block.type !== "figure" && block.type !== "source")) continue;
      const src = mediaSrc(projectId, block.mediaId);
      if (!src) continue;
      figures.push({
        src,
        alt: String(block.alt || ""),
        caption: block.type === "figure" && block.caption ? String(block.caption) : String(block.label || block.alt || ""),
      });
    }
    let figureIndex = 0;
    for (const block of blocks) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "heading" && (block.level === 2 || block.level === 3)) {
        wrap.append(el(block.level === 2 ? "h3" : "h4", "flow-heading", String(block.text || "")));
      } else if (block.type === "paragraph" && typeof block.text === "string") {
        wrap.append(renderProse(block.text));
      } else if (block.type === "list" && Array.isArray(block.items)) {
        const list = el(block.ordered === true ? "ol" : "ul");
        for (const item of block.items) {
          const li = el("li");
          appendInlines(li, parseInlines(String(item)));
          list.append(li);
        }
        wrap.append(list);
      } else if (block.type === "table" && Array.isArray(block.columns) && Array.isArray(block.rows)) {
        const scroller = el("div", "flow-table-wrap");
        const table = el("table", "flow-table");
        if (block.caption) table.append(el("caption", "", String(block.caption)));
        const head = el("thead");
        const headRow = el("tr");
        for (const column of block.columns) {
          const cell = el("th", "", String(column));
          cell.setAttribute("scope", "col");
          headRow.append(cell);
        }
        head.append(headRow);
        table.append(head);
        const body = el("tbody");
        for (const row of block.rows) {
          if (!Array.isArray(row)) continue;
          const tr = el("tr");
          row.forEach((cell, index) => {
            const td = el("td");
            const label = block.columns[index] == null ? "" : String(block.columns[index]);
            td.setAttribute("data-label", label);
            appendInlines(td, parseInlines(String(cell)));
            tr.append(td);
          });
          body.append(tr);
        }
        table.append(body);
        scroller.append(table);
        wrap.append(scroller);
      } else if (block.type === "callout" && typeof block.text === "string") {
        const aside = el("aside", "flow-callout");
        if (block.label) aside.append(el("p", "flow-callout-label", String(block.label)));
        aside.append(renderProse(block.text));
        wrap.append(aside);
      } else if (block.type === "figure" || block.type === "source") {
        const src = mediaSrc(projectId, block.mediaId);
        if (!src) continue;
        const current = figureIndex;
        figureIndex += 1;
        const alt = String(block.alt || "");
        if (block.type === "source") {
          const details = document.createElement("details");
          details.className = "flow-source";
          const summary = document.createElement("summary");
          summary.textContent = block.label ? String(block.label) : "View original page";
          details.append(summary);
          details.append(zoomableImage(src, alt, () => openLightbox(figures, current)));
          wrap.append(details);
        } else {
          const figure = el("figure", "flow-figure");
          figure.append(zoomableImage(src, alt, () => openLightbox(figures, current)));
          if (block.caption) {
            const caption = el("figcaption", "flow-caption");
            appendInlines(caption, parseInlines(String(block.caption)));
            figure.append(caption);
          }
          wrap.append(figure);
        }
      }
    }
    return wrap;
  }

  function renderProse(raw) {
    const wrap = el("div", "section-prose");
    for (const block of parseSectionText(raw)) {
      if (block.type === "heading") {
        wrap.append(el("h3", "", block.text));
      } else if (block.type === "list") {
        const list = el("ul");
        for (const item of block.items) {
          const li = el("li");
          appendInlines(li, item);
          list.append(li);
        }
        wrap.append(list);
      } else {
        const paragraph = el("p");
        appendInlines(paragraph, block.inlines);
        wrap.append(paragraph);
      }
    }
    return wrap;
  }

  function previewLine(section) {
    if (section && typeof section.summary === "string" && section.summary.trim()) {
      return section.summary.replace(/\s+/g, " ").trim();
    }
    const raw = (section && section.blocks ? section.blocks : [])
      .filter((block) => block && block.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("\n");
    const lines = raw.replace(/\r\n/g, "\n").split("\n").map((line) => line.trim()).filter(Boolean);
    const useful = lines.find((line) => !isSubheading(line)) || lines[0] || "";
    let line = plainSyntax(useful.replace(/^\s*[-*•]\s+/, "")).replace(/\s+/g, " ").trim();
    if (!line) return "";
    const sentence = /^.{1,140}?[.!?](?=\s|$)/.exec(line);
    if (sentence && sentence[0].length <= 120) return sentence[0];
    if (line.length <= 110) return line;
    const cut = line.slice(0, 107);
    const space = cut.lastIndexOf(" ");
    return (space > 60 ? cut.slice(0, space) : cut).replace(/[\s,;:–-]+$/u, "") + "…";
  }

  function appendBlocks(parent, section, presentation) {
    for (const block of section.blocks || []) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "widget" && safeId(block.mediaId, mediaPattern) && safeId(presentation.id, projectPattern)) {
        const open = el(
          "a",
          "open-widget",
          presentation.fictional === true
            ? `Open ${typeof block.title === "string" ? block.title : "viewer"}`
            : "Open 3D Kitchen Studio",
        );
        open.href = `/api/projects/${presentation.id}/widgets/${block.mediaId}/open`;
        open.target = "_blank";
        open.rel = "noopener noreferrer";
        parent.append(open);
      } else if (block.type === "flow") {
        parent.append(renderFlow(presentation.id, block));
      } else if (block.type === "text" && typeof block.text === "string") {
        parent.append(renderProse(block.text));
      } else if (block.type === "gallery" && Array.isArray(block.images)) {
        parent.append(renderGallery(presentation.id, block.images));
      } else if (block.type === "attachment") {
        const attachment = (presentation.attachments || []).find((entry) => entry && entry.id === block.attachmentId);
        const node = renderAttachment(presentation.id, attachment);
        if (node) parent.append(node);
      }
    }
  }

  function renderProject(root, presentation) {
    root.textContent = "";
    if (!presentation || typeof presentation !== "object") return root;
    if (presentation.fictional === true) {
      root.append(el("p", "fictional", "Fictional demo. This is not a client project and it is not Allison McElroy's work."));
    }
    const title = document.getElementById("page-title");
    if (title && typeof presentation.title === "string") title.textContent = presentation.title;
    const subtitle = document.getElementById("page-subtitle");
    if (subtitle) {
      const line = typeof presentation.subtitle === "string" ? presentation.subtitle.trim() : "";
      subtitle.textContent = line;
      subtitle.hidden = line.length === 0;
    }
    const kicker = document.getElementById("page-kicker");
    if (kicker) kicker.textContent = presentation.fictional === true ? "Fictional demo" : "Project";

    const grouped = { overview: [], sections: [], drawings: [], files: [] };
    for (const section of presentation.sections || []) {
      if (!section || !safeId(section.id, sectionPattern)) continue;
      grouped[sectionTab(section)].push(section);
    }
    const tabs = TAB_DEFS.filter((tab) => tab.id === "overview" || grouped[tab.id].length);
    const panels = {};
    const buttons = [];

    function showTab(id, writeHash) {
      const known = tabs.some((tab) => tab.id === id);
      const next = known ? id : tabs[0].id;
      for (const button of buttons) {
        const on = button.tabId === next;
        button.setAttribute("aria-selected", on ? "true" : "false");
        button.tabIndex = on ? 0 : -1;
      }
      for (const tab of tabs) panels[tab.id].hidden = tab.id !== next;
      if (writeHash) {
        try {
          const hash = "#" + next;
          if (globalThis.history && history.replaceState && location.hash !== hash) history.replaceState(null, "", hash);
        } catch {
          /* The hash is only a tab name. A missing location must not break viewing. */
        }
      }
      return next;
    }

    const bar = el("div", "project-bar");
    const tablist = el("div", "tablist");
    tablist.setAttribute("role", "tablist");
    tablist.setAttribute("aria-label", "Project");
    for (const tab of tabs) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "project-tab";
      button.tabId = tab.id;
      button.id = "tab-" + tab.id;
      button.setAttribute("role", "tab");
      button.setAttribute("aria-controls", "panel-" + tab.id);
      button.textContent = tab.label;
      button.addEventListener("click", () => showTab(tab.id, true));
      tablist.append(button);
      buttons.push(button);
      const panel = el("div", "tab-panel");
      panel.id = "panel-" + tab.id;
      panel.setAttribute("role", "tabpanel");
      panel.setAttribute("aria-labelledby", button.id);
      panels[tab.id] = panel;
    }
    tablist.addEventListener("keydown", (event) => {
      const names = ["ArrowRight", "ArrowLeft", "Home", "End"];
      if (names.indexOf(event.key) < 0) return;
      let index = buttons.indexOf(document.activeElement);
      if (index < 0) index = buttons.findIndex((button) => button.getAttribute("aria-selected") === "true");
      if (event.key === "ArrowRight") index = (index + 1) % buttons.length;
      else if (event.key === "ArrowLeft") index = (index - 1 + buttons.length) % buttons.length;
      else if (event.key === "Home") index = 0;
      else index = buttons.length - 1;
      event.preventDefault();
      buttons[index].focus();
      showTab(buttons[index].tabId, true);
    });
    bar.append(tablist);
    root.append(bar);

    if (typeof presentation.summary === "string") panels.overview.append(el("p", "summary", presentation.summary));
    for (const name of ["overview", "drawings", "files"]) {
      for (const section of grouped[name]) {
        const article = el("article", "project-section");
        article.id = "s-" + section.id;
        if (section.kicker) article.append(el("p", "flow-kicker", String(section.kicker)));
        if (section.title) article.append(el("h2", "", String(section.title)));
        appendBlocks(article, section, presentation);
        panels[name].append(article);
      }
    }
    grouped.sections.forEach((section, index) => {
      const details = document.createElement("details");
      details.className = "section-card";
      details.id = "s-" + section.id;
      if (index === 0) details.open = true;
      const summary = document.createElement("summary");
      summary.append(el("span", "section-card-title", String(section.title || "Section")));
      const line = previewLine(section);
      if (line) {
        const preview = el("span", "section-card-line", line);
        const authored = typeof section.summary === "string" && section.summary.trim().length > 0;
        if (!authored) preview.setAttribute("data-generated", "true");
        summary.append(preview);
      }
      details.append(summary);
      const body = el("div", "section-card-body");
      appendBlocks(body, section, presentation);
      details.append(body);
      panels.sections.append(details);
    });
    for (const tab of tabs) root.append(panels[tab.id]);

    function applyHash() {
      const hash = pageHash();
      if (tabs.some((tab) => tab.id === hash)) {
        showTab(hash, false);
        return;
      }
      if (hash.indexOf("s-") === 0) {
        for (const tab of tabs) {
          const node = panels[tab.id].querySelector ? panels[tab.id].querySelector("#" + hash) : null;
          if (!node) continue;
          showTab(tab.id, false);
          if ("open" in node) node.open = true;
          return;
        }
      }
      showTab(tabs[0].id, false);
    }
    globalThis.__amcApplyHash = applyHash;
    applyHash();
    return root;
  }

  let lastFocus = null;

  function openLightbox(images, index) {
    const dialog = document.getElementById("lightbox");
    if (!dialog || typeof dialog.showModal !== "function" || images.length === 0) return;
    const img = dialog.querySelector("img");
    const caption = dialog.querySelector(".lightbox-caption");
    let current = index;
    function show() {
      const image = images[current];
      img.src = image.src;
      img.alt = image.alt;
      caption.textContent = image.caption;
      capAtSource(img);
    }
    show();
    lastFocus = document.activeElement;
    if (!dialog.open) dialog.showModal();
    dialog.onclose = () => {
      if (lastFocus && lastFocus.focus) lastFocus.focus();
    };
    dialog.querySelector("[data-lightbox-prev]").onclick = () => {
      current = (current - 1 + images.length) % images.length;
      show();
    };
    dialog.querySelector("[data-lightbox-next]").onclick = () => {
      current = (current + 1) % images.length;
      show();
    };
    dialog.querySelector("[data-lightbox-close]").onclick = () => dialog.close();
  }

  async function boot() {
    const form = document.getElementById("access-form");
    if (!form) return;
    const input = document.getElementById("project-code");
    const error = document.getElementById("form-error");
    const project = document.getElementById("project");
    const gate = document.getElementById("gate");

    function showError(message) {
      error.textContent = message;
    }

    function showProject(presentation) {
      showError("");
      gate.hidden = true;
      project.hidden = false;
      renderProject(project, presentation);
      const heading = document.getElementById("page-title");
      if (heading && heading.focus) heading.focus();
    }

    async function submitCode() {
      const submitted = input.value;
      input.value = "";
      showError("");
      let response;
      try {
        response = await fetch("/api/access", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ code: submitted }),
        });
      } catch {
        showError("Project access is unavailable right now.");
        return;
      }
      let data = {};
      try {
        data = await response.json();
      } catch {
        data = {};
      }
      if (!response.ok || !data.project) {
        const fallback = response.status === 503 ? "Project access is unavailable right now." : "That code is not valid.";
        const message = typeof data.error === "string" && !data.error.includes(submitted) ? data.error.slice(0, 200) : fallback;
        showError(response.status === 503 ? fallback : message);
        return;
      }
      showProject(data.project);
    }

    const submit = document.getElementById("access-submit");
    if (submit) submit.addEventListener("click", () => submitCode());
    if (input) {
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          submitCode();
        }
      });
    }

    try {
      const existing = await fetch("/api/session", {
        credentials: "same-origin",
        headers: { accept: "application/json" },
      });
      if (existing.ok) {
        const data = await existing.json();
        if (data && data.authenticated && data.project) showProject(data.project);
      }
    } catch {
      showError("Project access is unavailable right now.");
    }
  }

  if (typeof globalThis.addEventListener === "function" && !globalThis.__amcHashBound) {
    globalThis.__amcHashBound = true;
    globalThis.addEventListener("hashchange", () => {
      if (typeof globalThis.__amcApplyHash === "function") globalThis.__amcApplyHash();
    });
  }

  const api = { renderProject, isHttps, parseSectionText };
  globalThis.projectView = api;
  if (typeof document !== "undefined" && document.getElementById) boot();
})();
