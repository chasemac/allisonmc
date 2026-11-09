import { SchemaError } from "./errors.js";
import { MEDIA_ID, PROJECT_ID, SECTION_ID } from "./codes.js";
import { safeFilename } from "./media-types.js";

const TOP_KEYS = ["id", "title", "subtitle", "summary", "fictional", "sections", "attachments"];

function onlyKeys(obj, keys) {
  const allowed = new Set(keys);
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) throw new SchemaError("unexpected field");
  }
}

function text(value, max) {
  if (typeof value !== "string") throw new SchemaError("expected text");
  const clean = value.replace(/\r\n/g, "\n");
  if (clean.length === 0 || clean.length > max) throw new SchemaError("text length");
  if (clean.includes("\u0000")) throw new SchemaError("invalid text");
  return clean;
}

function optionalLine(value, max) {
  if (value === undefined) return undefined;
  const clean = text(value, max).replace(/\s+/g, " ").trim();
  if (!clean) throw new SchemaError("text length");
  return clean;
}

function httpsUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new SchemaError("invalid link");
  }
  if (url.protocol !== "https:") throw new SchemaError("invalid link");
  if (url.username || url.password) throw new SchemaError("invalid link");
  if (url.href.length > 2000) throw new SchemaError("invalid link");
  return url.href;
}

export function validatePresentation(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new SchemaError("invalid project");
  onlyKeys(input, TOP_KEYS);
  if (!PROJECT_ID.test(input.id || "")) throw new SchemaError("invalid project id");
  if (typeof input.fictional !== "boolean") throw new SchemaError("fictional flag required");
  const title = text(input.title, 200);
  const subtitle = optionalLine(input.subtitle, 240);
  const summary = text(input.summary, 8000);
  if (!Array.isArray(input.sections) || input.sections.length < 1 || input.sections.length > 40) {
    throw new SchemaError("sections");
  }
  if (!Array.isArray(input.attachments) || input.attachments.length > 40) throw new SchemaError("attachments");

  const sectionIds = new Set();
  const sections = input.sections.map((section) => {
    if (!section || typeof section !== "object" || Array.isArray(section)) throw new SchemaError("section");
    onlyKeys(section, ["id", "title", "kicker", "summary", "blocks"]);
    if (!SECTION_ID.test(section.id || "")) throw new SchemaError("section id");
    if (sectionIds.has(section.id)) throw new SchemaError("duplicate section");
    sectionIds.add(section.id);
    if (!Array.isArray(section.blocks) || section.blocks.length < 1 || section.blocks.length > 40) {
      throw new SchemaError("blocks");
    }
    const cleanSection = {
      id: section.id,
      title: text(section.title, 200),
      blocks: section.blocks.map(cleanBlock),
    };
    const kicker = optionalLine(section.kicker, 160);
    if (kicker !== undefined) cleanSection.kicker = kicker;
    const sectionSummary = optionalLine(section.summary, 180);
    if (sectionSummary !== undefined) cleanSection.summary = sectionSummary;
    return cleanSection;
  });

  const attachmentIds = new Set();
  const attachments = input.attachments.map((attachment) => {
    if (!attachment || typeof attachment !== "object" || Array.isArray(attachment)) throw new SchemaError("attachment");
    if (!MEDIA_ID.test(attachment.id || "")) throw new SchemaError("attachment id");
    if (attachmentIds.has(attachment.id)) throw new SchemaError("duplicate attachment");
    attachmentIds.add(attachment.id);
    const label = text(attachment.label, 200);
    if (attachment.kind === "file") {
      onlyKeys(attachment, ["id", "label", "kind", "mediaId", "filename"]);
      if (!MEDIA_ID.test(attachment.mediaId || "")) throw new SchemaError("attachment media");
      const filename = safeFilename(attachment.filename);
      if (!filename) throw new SchemaError("attachment filename");
      return { id: attachment.id, label, kind: "file", mediaId: attachment.mediaId, filename };
    }
    if (attachment.kind === "link") {
      onlyKeys(attachment, ["id", "label", "kind", "href"]);
      return { id: attachment.id, label, kind: "link", href: httpsUrl(attachment.href) };
    }
    throw new SchemaError("attachment kind");
  });

  for (const section of sections) {
    for (const block of section.blocks) {
      if (block.type === "attachment" && !attachmentIds.has(block.attachmentId)) {
        throw new SchemaError("unknown attachment");
      }
    }
  }

  const clean = subtitle === undefined
    ? { id: input.id, title, summary, fictional: input.fictional, sections, attachments }
    : { id: input.id, title, subtitle, summary, fictional: input.fictional, sections, attachments };
  if (JSON.stringify(clean).length > 500_000) throw new SchemaError("project is too large");
  return clean;
}

function cleanBlock(block) {
  if (!block || typeof block !== "object" || Array.isArray(block)) throw new SchemaError("block");
  if (block.type === "text") {
    onlyKeys(block, ["type", "text"]);
    return { type: "text", text: text(block.text, 20000) };
  }
  if (block.type === "gallery") {
    onlyKeys(block, ["type", "images"]);
    if (!Array.isArray(block.images) || block.images.length < 1 || block.images.length > 40) {
      throw new SchemaError("gallery");
    }
    return {
      type: "gallery",
      images: block.images.map((image) => {
        if (!image || typeof image !== "object" || Array.isArray(image)) throw new SchemaError("image");
        onlyKeys(image, ["mediaId", "alt", "caption"]);
        if (!MEDIA_ID.test(image.mediaId || "")) throw new SchemaError("image id");
        const clean = { mediaId: image.mediaId, alt: text(image.alt, 300) };
        if (image.caption !== undefined) clean.caption = text(image.caption, 300);
        return clean;
      }),
    };
  }
  if (block.type === "widget") {
    onlyKeys(block, ["type", "mediaId", "title"]);
    if (!MEDIA_ID.test(block.mediaId || "")) throw new SchemaError("widget id");
    return { type: "widget", mediaId: block.mediaId, title: text(block.title, 200) };
  }
  if (block.type === "attachment") {
    onlyKeys(block, ["type", "attachmentId"]);
    if (!MEDIA_ID.test(block.attachmentId || "")) throw new SchemaError("attachment id");
    return { type: "attachment", attachmentId: block.attachmentId };
  }
  if (block.type === "flow") return cleanFlow(block);
  throw new SchemaError("unsupported block");
}

function cleanFlow(block) {
  onlyKeys(block, ["type", "blocks"]);
  if (!Array.isArray(block.blocks) || block.blocks.length < 1 || block.blocks.length > 80) {
    throw new SchemaError("flow");
  }
  return { type: "flow", blocks: block.blocks.map(cleanFlowItem) };
}

function cellText(value) {
  if (typeof value !== "string") throw new SchemaError("table cell");
  const clean = value.replace(/\r\n/g, "\n");
  if (clean.length > 400) throw new SchemaError("text length");
  if (clean.includes("\u0000")) throw new SchemaError("invalid text");
  return clean;
}

function cleanFlowItem(block) {
  if (!block || typeof block !== "object" || Array.isArray(block)) throw new SchemaError("flow block");
  if (block.type === "heading") {
    onlyKeys(block, ["type", "level", "text"]);
    if (block.level !== 2 && block.level !== 3) throw new SchemaError("heading level");
    return { type: "heading", level: block.level, text: text(block.text, 200) };
  }
  if (block.type === "paragraph") {
    onlyKeys(block, ["type", "text"]);
    return { type: "paragraph", text: text(block.text, 4000) };
  }
  if (block.type === "list") {
    onlyKeys(block, ["type", "ordered", "items"]);
    if (typeof block.ordered !== "boolean") throw new SchemaError("list");
    if (!Array.isArray(block.items) || block.items.length < 1 || block.items.length > 40) {
      throw new SchemaError("list");
    }
    return { type: "list", ordered: block.ordered, items: block.items.map((item) => text(item, 2000)) };
  }
  if (block.type === "table") {
    onlyKeys(block, ["type", "caption", "columns", "rows"]);
    if (!Array.isArray(block.columns) || block.columns.length < 1 || block.columns.length > 8) {
      throw new SchemaError("table");
    }
    const columns = block.columns.map((column) => text(column, 80));
    if (!Array.isArray(block.rows) || block.rows.length < 1 || block.rows.length > 40) throw new SchemaError("table");
    const rows = block.rows.map((row) => {
      if (!Array.isArray(row) || row.length !== columns.length) throw new SchemaError("table");
      return row.map(cellText);
    });
    const clean = { type: "table", columns, rows };
    if (block.caption !== undefined) clean.caption = text(block.caption, 200);
    return clean;
  }
  if (block.type === "callout") {
    onlyKeys(block, ["type", "label", "text"]);
    const clean = { type: "callout", text: text(block.text, 4000) };
    if (block.label !== undefined) clean.label = text(block.label, 80);
    return clean;
  }
  if (block.type === "figure") {
    onlyKeys(block, ["type", "mediaId", "alt", "caption"]);
    if (!MEDIA_ID.test(block.mediaId || "")) throw new SchemaError("figure id");
    const clean = { type: "figure", mediaId: block.mediaId, alt: text(block.alt, 300) };
    if (block.caption !== undefined) clean.caption = text(block.caption, 300);
    return clean;
  }
  if (block.type === "source") {
    onlyKeys(block, ["type", "mediaId", "alt", "label"]);
    if (!MEDIA_ID.test(block.mediaId || "")) throw new SchemaError("source id");
    const clean = { type: "source", mediaId: block.mediaId, alt: text(block.alt, 300) };
    if (block.label !== undefined) clean.label = text(block.label, 80);
    return clean;
  }
  throw new SchemaError("unsupported flow block");
}
