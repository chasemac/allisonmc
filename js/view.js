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

  const projectPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
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
    if (typeof presentation.summary === "string") root.append(el("p", "summary", presentation.summary));

    const nav = document.createElement("nav");
    nav.className = "section-nav";
    nav.setAttribute("aria-label", "Project sections");
    const list = el("ul");
    for (const section of presentation.sections || []) {
      if (!section || !safeId(section.id, projectPattern)) continue;
      const item = el("li");
      const link = el("a", "", String(section.title || "Section"));
      link.setAttribute("href", `#s-${section.id}`);
      item.append(link);
      list.append(item);
    }
    nav.append(list);
    root.append(nav);

    const leave = el("button", "text-button", "Leave project");
    leave.type = "button";
    leave.id = "leave-project";
    root.append(leave);

    for (const section of presentation.sections || []) {
      if (!section || !safeId(section.id, projectPattern)) continue;
      const article = el("article", "project-section");
      article.id = `s-${section.id}`;
      article.append(el("h2", "", String(section.title || "")));
      for (const block of section.blocks || []) {
        if (!block || typeof block !== "object") continue;
        if (block.type === "text" && typeof block.text === "string") {
          article.append(el("p", "", block.text));
        } else if (block.type === "gallery" && Array.isArray(block.images)) {
          article.append(renderGallery(presentation.id, block.images));
        } else if (block.type === "attachment") {
          const attachment = (presentation.attachments || []).find((entry) => entry && entry.id === block.attachmentId);
          const node = renderAttachment(presentation.id, attachment);
          if (node) article.append(node);
        }
      }
      root.append(article);
    }
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
      const leave = document.getElementById("leave-project");
      if (leave) leave.addEventListener("click", leaveProject);
      const heading = document.getElementById("page-title");
      if (heading && heading.focus) heading.focus();
    }

    async function leaveProject() {
      await fetch("/api/logout", {
        method: "POST",
        credentials: "same-origin",
        headers: { accept: "application/json" },
      });
      project.textContent = "";
      project.hidden = true;
      gate.hidden = false;
      const title = document.getElementById("page-title");
      const kicker = document.getElementById("page-kicker");
      if (title) title.textContent = "Project access";
      if (kicker) kicker.textContent = "Private viewing";
      if (input) input.focus();
    }

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
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
    });

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

  const api = { renderProject, isHttps };
  globalThis.projectView = api;
  if (typeof document !== "undefined" && document.getElementById) boot();
})();
