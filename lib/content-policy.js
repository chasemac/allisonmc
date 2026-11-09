import { MEDIA_ID, PROJECT_ID, SECTION_ID, SUBMISSION_ID } from "./codes.js";
import { detectMedia, MAX_MEDIA_BYTES, safeFilename } from "./media-types.js";
import { SchemaError } from "./errors.js";
import { validatePresentation } from "./schema.js";

export const ASSET_ROLES = [
  "interactive-3d-viewer",
  "3d-preview",
  "downloadable-3d-model",
  "hero",
  "gallery",
  "page-preview",
  "plan-sheet",
  "proposal-preview",
  "punchlist-preview",
  "reference-photo",
  "figure",
  "source-page",
  "downloadable-pdf",
];

const IMAGE_ROLES = new Set([
  "3d-preview",
  "hero",
  "gallery",
  "page-preview",
  "plan-sheet",
  "proposal-preview",
  "punchlist-preview",
  "reference-photo",
  "figure",
  "source-page",
]);

const INLINE_ROLES = new Set(["figure", "source-page"]);

const ROLE_ORDER = ["hero", "interactive-3d-viewer", "3d-preview", "page-preview", "plan-sheet", "proposal-preview", "punchlist-preview", "reference-photo", "gallery", "downloadable-3d-model", "downloadable-pdf"];

const ROLE_TITLE = {
  hero: "Hero",
  "interactive-3d-viewer": "Interactive viewer",
  "3d-preview": "3D preview",
  "page-preview": "Page preview",
  "plan-sheet": "Plan sheet",
  "proposal-preview": "Proposal preview",
  "punchlist-preview": "Punch list preview",
  "reference-photo": "Reference photo",
  gallery: "Gallery",
  "downloadable-3d-model": "3D model",
  "downloadable-pdf": "PDF",
};

export const WIDGET_CSP = "sandbox allow-scripts allow-downloads allow-popups; default-src 'none'; script-src 'unsafe-inline' https://www.gstatic.com; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'";
export const DEFAULT_SCRIPT_SRC_ORIGINS = ["https://www.gstatic.com"];

export const APPROVED_UNUSED_SCRIPT = "https://www.gstatic.com/antigravity/web/dev/tailwindcss.min.js";

function textOf(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new SchemaError("file is not utf-8 text");
  }
}

const COLLADA_NAMESPACE = "http://www.collada.org/2005/11/COLLADASchema";

function externalUrls(text) {
  return [...text.matchAll(/https?:\/\/[^\s"'<>)]+/gi)]
    .map((match) => match[0])
    .filter((url) => url !== COLLADA_NAMESPACE);
}

function isAllowedScriptSrc(value, allowlist) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password) return false;
  return allowlist.some((origin) => {
    try {
      return url.origin === new URL(origin).origin;
    } catch {
      return false;
    }
  });
}

export function widgetProblems(bytes, options = {}) {
  const text = textOf(bytes);
  const allowlist = Array.isArray(options.scriptSrcAllowlist) && options.scriptSrcAllowlist.length
    ? options.scriptSrcAllowlist
    : DEFAULT_SCRIPT_SRC_ORIGINS;
  const problems = [];
  if (text.includes("\u0000")) problems.push("invalid text");
  const scriptSrcs = [...text.matchAll(/<script\b[^>]*\bsrc\s*=\s*['"]([^'"]+)['"]/gi)].map((match) => match[1]);
  for (const src of scriptSrcs) {
    if (!isAllowedScriptSrc(src, allowlist)) problems.push(`external script src: ${src}`);
  }
  if (/<link\b[^>]*\bhref\s*=/i.test(text)) problems.push("external stylesheet link");
  if (/javascript:|vbscript:/i.test(text)) problems.push("script url");
  if (/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|importScripts)\s*\(/i.test(text)) problems.push("network call");
  if (/\bimport\s*\(|new\s+Worker\s*\(/i.test(text)) problems.push("network call");
  if (/<iframe\b|<object\b|<embed\b|<base\b/i.test(text)) problems.push("nested frame");
  const allowedScripts = new Set(scriptSrcs.filter((src) => isAllowedScriptSrc(src, allowlist)));
  const urls = externalUrls(text).filter((url) => !allowedScripts.has(url));
  if (urls.length) problems.push(`external url: ${urls[0]}`);
  if (!/<\s*html[\s>]/i.test(text) || !/<\s*script\b/i.test(text) && !/<\s*style\b/i.test(text)) {
    if (!problems.length) problems.push("not a self-contained widget");
  }
  return problems;
}

export function validateWidgetHtml(bytes) {
  const problems = widgetProblems(bytes);
  if (problems.length) throw new SchemaError(problems[0]);
  return { contentType: "text/html", bytes: Buffer.from(bytes) };
}

function decodeXmlText(value) {
  if (/&(?!(?:amp|lt|gt|quot|apos);)/.test(value)) return null;
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'");
}

export function colladaReferences(bytes) {
  const text = textOf(bytes);
  if (/<!DOCTYPE|<!ENTITY|<!NOTATION|<!\[CDATA\[/i.test(text)) {
    throw new SchemaError("xml doctype or entity");
  }
  const values = [];
  let index = 0;
  while (index < text.length) {
    if (text.startsWith("<!--", index)) {
      const end = text.indexOf("-->", index + 4);
      if (end < 0) throw new SchemaError("xml doctype or entity");
      index = end + 3;
      continue;
    }
    if (text.slice(index, index + 10).toLowerCase() === "<init_from" && /[\s>/]/.test(text[index + 10] || "")) {
      const open = text.indexOf(">", index);
      if (open < 0) throw new SchemaError("external dae init_from");
      const tag = text.slice(index, open + 1);
      if (!/^<init_from\s*>$/i.test(tag)) throw new SchemaError("external dae init_from");
      const close = text.toLowerCase().indexOf("</init_from>", open + 1);
      if (close < 0) throw new SchemaError("external dae init_from");
      const raw = text.slice(open + 1, close);
      if (raw.includes("<")) throw new SchemaError("external dae init_from");
      const decoded = decodeXmlText(raw.trim());
      if (decoded === null) throw new SchemaError("xml doctype or entity");
      values.push(decoded);
      index = close + "</init_from>".length;
      continue;
    }
    index += 1;
  }
  return values;
}

export function exactAssetReference(fromPath, value, files) {
  if (!value || /[\0\\]/.test(value) || value.includes("..")) return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value) || value.startsWith("//") || value.startsWith("/")) return false;
  if (files.has(value)) return true;
  const directory = fromPath.includes("/") ? fromPath.slice(0, fromPath.lastIndexOf("/")) : "";
  const parts = [];
  for (const part of `${directory}/${value}`.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") return false;
    parts.push(part);
  }
  return files.has(parts.join("/"));
}

export function colladaProblems(bytes) {
  const problems = [];
  let text = "";
  try {
    text = textOf(bytes);
  } catch (err) {
    return [err instanceof SchemaError ? err.message : "file is not utf-8 text"];
  }
  if (!/<COLLADA\b/i.test(text)) problems.push("not a collada file");
  try {
    const references = colladaReferences(bytes);
    for (const value of references) {
      if (!value || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value) || value.startsWith("//") || value.startsWith("/") || value.includes("..")) {
        problems.push("external dae init_from");
      }
    }
  } catch (err) {
    problems.push(err instanceof SchemaError ? err.message : "external dae init_from");
  }
  if (/<script\b|<html\b|<svg\b/i.test(text)) problems.push("unexpected markup");
  return problems;
}

export function validateCollada(bytes) {
  const problems = colladaProblems(bytes);
  if (problems.length) throw new SchemaError(problems[0]);
  return { contentType: "model/vnd.collada+xml", bytes: Buffer.from(bytes) };
}

export function classifyAsset(filename, bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buffer.length === 0 || buffer.length > MAX_MEDIA_BYTES) throw new SchemaError("media file is too large");
  bytes = buffer;
  const safe = safeFilename(filename);
  if (!safe) throw new SchemaError("asset file name");
  const lower = safe.toLowerCase();
  if (lower.endsWith(".html")) {
    return {
      contentType: "text/html",
      bytes: Buffer.from(bytes),
      filename: safe,
      kind: "widget",
      problems: widgetProblems(bytes),
    };
  }
  if (lower.endsWith(".dae")) {
    const validated = validateCollada(bytes);
    return { ...validated, filename: safe, kind: "dae", text: textOf(validated.bytes), references: colladaReferences(validated.bytes) };
  }
  const detected = detectMedia(bytes);
  if (!detected) throw new SchemaError("media type is not allowed");
  const expected = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".pdf": "application/pdf",
  };
  const extension = lower.slice(lower.lastIndexOf("."));
  if (expected[extension] !== detected.contentType) throw new SchemaError("media type is not allowed");
  return { ...detected, filename: safe, kind: detected.contentType === "application/pdf" ? "pdf" : "image" };
}

function requiredString(object, key, max) {
  if (!object || typeof object[key] !== "string") throw new SchemaError(`missing ${key}`);
  const value = object[key].replace(/\r\n/g, "\n");
  if (value.length > max || value.includes("\u0000")) throw new SchemaError(`invalid ${key}`);
  return value;
}

function optionalSubmissionLine(object, key, max) {
  if (!object || !Object.prototype.hasOwnProperty.call(object, key)) return undefined;
  const value = requiredString(object, key, max).replace(/\s+/g, " ").trim();
  if (!value) throw new SchemaError(`invalid ${key}`);
  return value;
}

function mediaIdFor(assetPath) {
  const base = assetPath.split("/").pop().replace(/\.[^.]+$/, "");
  if (!MEDIA_ID.test(base)) throw new SchemaError("asset file name");
  return base;
}

const FLOW_BLOCK_TYPES = new Set(["heading", "paragraph", "list", "table", "callout", "figure", "source"]);

function submissionFlowBlock(block, byPath, referencedInline) {
  if (!block || typeof block !== "object" || Array.isArray(block)) throw new SchemaError("flow block");
  if (!FLOW_BLOCK_TYPES.has(block.type)) throw new SchemaError("unsupported flow block");
  if (block.type !== "figure" && block.type !== "source") return block;
  const allowed = block.type === "figure" ? ["type", "path", "alt", "caption"] : ["type", "path", "alt", "label"];
  for (const key of Object.keys(block)) {
    if (!allowed.includes(key)) throw new SchemaError("unexpected flow field");
  }
  const asset = byPath.get(String(block.path || ""));
  if (!asset) throw new SchemaError("missing asset");
  const expected = block.type === "figure" ? "figure" : "source-page";
  if (asset.role !== expected) throw new SchemaError("asset role does not match block");
  referencedInline.add(asset.mediaId);
  if (block.type === "figure") {
    const clean = { type: "figure", mediaId: asset.mediaId, alt: block.alt };
    if (block.caption !== undefined) clean.caption = block.caption;
    return clean;
  }
  const clean = { type: "source", mediaId: asset.mediaId, alt: block.alt };
  if (block.label !== undefined) clean.label = block.label;
  return clean;
}

function mapDocuments(content, byPath, referencedInline, takeId) {
  if (!Object.prototype.hasOwnProperty.call(content, "documents")) return [];
  const documents = content.documents;
  if (!Array.isArray(documents) || documents.length < 1 || documents.length > 12) throw new SchemaError("documents");
  return documents.map((doc) => {
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new SchemaError("document");
    for (const key of Object.keys(doc)) {
      if (!["id", "heading", "kicker", "summary", "blocks"].includes(key)) throw new SchemaError("unexpected document field");
    }
    if (!SECTION_ID.test(doc.id || "")) throw new SchemaError("document id");
    if (!Array.isArray(doc.blocks) || doc.blocks.length < 1 || doc.blocks.length > 80) throw new SchemaError("flow");
    const mapped = {
      id: takeId(doc.id),
      title: requiredString(doc, "heading", 200),
      blocks: [{ type: "flow", blocks: doc.blocks.map((block) => submissionFlowBlock(block, byPath, referencedInline)) }],
    };
    const kicker = optionalSubmissionLine(doc, "kicker", 160);
    if (kicker !== undefined) mapped.kicker = kicker;
    const summary = optionalSubmissionLine(doc, "summary", 180);
    if (summary !== undefined) mapped.summary = summary;
    return mapped;
  });
}

export function mapSubmission(document, files) {
  if (!document || typeof document !== "object" || Array.isArray(document)) throw new SchemaError("invalid submission");
  const top = ["projectId", "submissionId", "title", "subtitle", "client", "location", "preparedBy", "date", "notesForReviewers", "content", "assets"];
  for (const key of Object.keys(document)) {
    if (!top.includes(key)) throw new SchemaError("unexpected submission field");
  }
  if (!PROJECT_ID.test(document.projectId || "")) throw new SchemaError("invalid project id");
  if (!SUBMISSION_ID.test(document.submissionId || "")) throw new SchemaError("invalid submission id");
  const title = requiredString(document, "title", 200);
  const subtitle = optionalSubmissionLine(document, "subtitle", 240);
  const client = requiredString(document, "client", 200);
  const location = requiredString(document, "location", 200);
  const preparedBy = requiredString(document, "preparedBy", 200);
  const date = requiredString(document, "date", 80);
  const notes = requiredString(document, "notesForReviewers", 8000);
  const content = document.content;
  if (!content || typeof content !== "object" || Array.isArray(content)) throw new SchemaError("invalid content");
  for (const key of Object.keys(content)) {
    if (!["summary", "sections", "documents"].includes(key)) throw new SchemaError("unexpected content field");
  }
  const summary = requiredString(content, "summary", 8000);
  if (!Array.isArray(content.sections) || content.sections.length < 1) throw new SchemaError("sections");
  if (!Array.isArray(document.assets)) throw new SchemaError("assets");
  const seenPaths = new Set();
  const seenIds = new Set();
  const assets = document.assets.map((asset) => {
    if (!asset || typeof asset !== "object" || Array.isArray(asset)) throw new SchemaError("asset");
    for (const key of Object.keys(asset)) {
      if (!["path", "role", "note"].includes(key)) throw new SchemaError("unexpected asset field");
    }
    if (!ASSET_ROLES.includes(asset.role)) throw new SchemaError("unknown asset role");
    const assetPath = String(asset.path || "");
    if (!assetPath.startsWith("assets/") || assetPath.includes("..") || assetPath.includes("\\") || assetPath.includes("\0")) {
      throw new SchemaError("asset path");
    }
    if (seenPaths.has(assetPath)) throw new SchemaError("duplicate asset");
    seenPaths.add(assetPath);
    const file = files.get(assetPath);
    if (!file) throw new SchemaError("missing asset");
    const mediaId = mediaIdFor(assetPath);
    if (seenIds.has(mediaId)) throw new SchemaError("duplicate asset name");
    seenIds.add(mediaId);
    const kindOk = {
      "interactive-3d-viewer": file.kind === "widget",
      "downloadable-3d-model": file.kind === "dae",
      "downloadable-pdf": file.kind === "pdf",
    };
    if (kindOk[asset.role] === false || (IMAGE_ROLES.has(asset.role) && file.kind !== "image")) {
      throw new SchemaError("asset role does not match file");
    }
    if (file.kind === "dae") {
      for (const value of file.references || []) {
        if (!exactAssetReference(assetPath, value, files)) throw new SchemaError("dae init_from is not in the submission");
      }
    }
    return { ...file, path: assetPath, role: asset.role, note: requiredString({ note: asset.note || "" }, "note", 500), mediaId };
  });
  if (assets.length !== files.size) throw new SchemaError("asset list does not match files");

  const detailLines = [
    ["Client", client],
    ["Location", location],
    ["Prepared by", preparedBy],
    ["Date", date],
  ].filter(([, value]) => value.trim());
  const sections = [];
  function takeId(preferred) {
    if (!SECTION_ID.test(preferred) || sections.some((item) => item.id === preferred)) {
      throw new SchemaError("duplicate section");
    }
    return preferred;
  }
  if (detailLines.length) {
    sections.push({
      id: takeId("meta-details"),
      title: "Details",
      blocks: detailLines.map(([name, value]) => ({ type: "text", text: `${name}: ${value}` })),
    });
  }
  content.sections.forEach((section, index) => {
    if (!section || typeof section !== "object") throw new SchemaError("section");
    for (const key of Object.keys(section)) {
      if (!["id", "heading", "body", "summary"].includes(key)) throw new SchemaError("unexpected section field");
    }
    if (!SECTION_ID.test(section.id || "")) throw new SchemaError("section id");
    const mapped = {
      id: takeId(section.id),
      title: requiredString(section, "heading", 200),
      blocks: [{ type: "text", text: requiredString(section, "body", 20000) }],
    };
    const sectionSummary = optionalSubmissionLine(section, "summary", 180);
    if (sectionSummary !== undefined) mapped.summary = sectionSummary;
    sections.push(mapped);
    if (index > 40) throw new SchemaError("sections");
  });
  if (notes.trim()) {
    sections.push({
      id: takeId("meta-notes"),
      title: "Notes for reviewers",
      blocks: [{ type: "text", text: notes.trim() }],
    });
  }
  const byPath = new Map(assets.map((asset) => [asset.path, asset]));
  const referencedInline = new Set();
  const documentSections = mapDocuments(content, byPath, referencedInline, takeId);
  for (const asset of assets) {
    if (INLINE_ROLES.has(asset.role) && !referencedInline.has(asset.mediaId)) {
      throw new SchemaError("unreferenced inline asset");
    }
  }
  const attachments = [];
  let documentsInserted = false;
  for (const role of ROLE_ORDER) {
    if (role === "page-preview") {
      sections.push(...documentSections);
      documentsInserted = true;
    }
    const group = assets.filter((asset) => asset.role === role);
    if (!group.length) continue;
    const sectionId = takeId(`role-${role}`);
    if (role === "interactive-3d-viewer") {
      sections.push({
        id: sectionId,
        title: ROLE_TITLE[role],
        blocks: group.map((asset) => ({ type: "widget", mediaId: asset.mediaId, title: asset.note || ROLE_TITLE[role] })),
      });
    } else if (IMAGE_ROLES.has(role)) {
      sections.push({
        id: sectionId,
        title: ROLE_TITLE[role],
        blocks: [{
          type: "gallery",
          images: group.map((asset) => ({
            mediaId: asset.mediaId,
            alt: asset.note || ROLE_TITLE[role],
            caption: asset.note || ROLE_TITLE[role],
          })),
        }],
      });
    } else {
      for (const asset of group) {
        attachments.push({
          id: asset.mediaId,
          label: asset.note || asset.filename,
          kind: "file",
          mediaId: asset.mediaId,
          filename: asset.filename,
        });
      }
      sections.push({
        id: sectionId,
        title: ROLE_TITLE[role],
        blocks: group.map((asset) => ({ type: "attachment", attachmentId: asset.mediaId })),
      });
    }
  }
  if (!documentsInserted && documentSections.length) sections.push(...documentSections);
  const presentationInput = {
    id: document.projectId,
    title,
    summary,
    fictional: false,
    sections,
    attachments,
  };
  if (subtitle !== undefined) presentationInput.subtitle = subtitle;
  const presentation = validatePresentation(presentationInput);
  return { presentation, assets };
}
