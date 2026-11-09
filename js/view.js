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
    if (id.indexOf("role-") === 0) {
      const role = id.slice(5);
      if (["hero", "3d-preview", "page-preview", "plan-sheet", "proposal-preview", "punchlist-preview", "reference-photo", "gallery"].indexOf(role) >= 0) {
        return "drawings";
      }
      return "files";
    }
    const types = blocks.map((block) => (block && block.type) || "");
    if (types.indexOf("widget") >= 0) return "files";
    if (types.indexOf("gallery") >= 0) return "drawings";
    if (types.indexOf("attachment") >= 0) return "files";
    const text = blocks.map((block) => (block && block.type === "text" ? block.text : "")).join("");
    return text.length > 180 ? "sections" : "overview";
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
      } else if (block.type === "text" && typeof block.text === "string") {
        parent.append(el("p", "", block.text));
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
        if (section.title) article.append(el("h2", "", String(section.title)));
        appendBlocks(article, section, presentation);
        panels[name].append(article);
      }
    }
    grouped.sections.forEach((section, index) => {
      const details = document.createElement("details");
      details.className = "fold";
      details.id = "s-" + section.id;
      if (index === 0) details.open = true;
      const summary = document.createElement("summary");
      summary.textContent = String(section.title || "Section");
      details.append(summary);
      const body = el("div", "fold-body");
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

  const api = { renderProject, isHttps };
  globalThis.projectView = api;
  if (typeof document !== "undefined" && document.getElementById) boot();
})();
