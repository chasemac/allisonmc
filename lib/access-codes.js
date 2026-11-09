import { lookupHash, normalizeCode, isAcceptableCode, PROJECT_ID } from "./codes.js";
import { SchemaError } from "./errors.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DAYS = 365;
const MAX_DAYS = 1095;

export function expiryFromAccessEntry(entry, now = Date.now()) {
  if (!entry || entry.expiresOn === undefined || entry.expiresOn === "") {
    return now + DEFAULT_DAYS * DAY_MS;
  }
  if (typeof entry.expiresOn !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(entry.expiresOn)) {
    throw new SchemaError("expiresOn must be YYYY-MM-DD");
  }
  const expiresAt = Date.parse(`${entry.expiresOn}T23:59:59.999Z`);
  if (!Number.isFinite(expiresAt)) throw new SchemaError("expiresOn must be YYYY-MM-DD");
  if (expiresAt <= now) throw new SchemaError("expiresOn is in the past");
  if (expiresAt > now + MAX_DAYS * DAY_MS) throw new SchemaError("expiresOn is too far away");
  return expiresAt;
}

function labelOf(entry, index) {
  const label = entry && entry.label !== undefined ? String(entry.label) : "";
  if (label.length > 120 || /[\r\n]/.test(label)) throw new SchemaError(`code ${index + 1} label is not usable`);
  return label.replace(/\s+/g, " ").trim();
}

export async function importAccessFile(services, document, now = Date.now()) {
  if (!document || typeof document !== "object" || Array.isArray(document)) throw new SchemaError("invalid access file");
  const allowed = new Set(["projectId", "codes"]);
  for (const key of Object.keys(document)) {
    if (!allowed.has(key)) throw new SchemaError("unexpected access field");
  }
  if (!PROJECT_ID.test(document.projectId || "")) throw new SchemaError("invalid project id");
  const project = await services.store.getProject(document.projectId);
  if (!project) throw new SchemaError("Unknown project.");
  if (!Array.isArray(document.codes) || document.codes.length < 1 || document.codes.length > 50) {
    throw new SchemaError("codes");
  }
  const planned = [];
  for (const [index, entry] of document.codes.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new SchemaError(`code ${index + 1} is not usable`);
    for (const key of Object.keys(entry)) {
      if (!["code", "label", "expiresOn"].includes(key)) throw new SchemaError("unexpected access field");
    }
    const code = normalizeCode(entry.code);
    if (!isAcceptableCode(code)) throw new SchemaError(`code ${index + 1} is not usable`);
    const hash = lookupHash(code, services.pepper);
    const existing = await services.store.getCodeByHash(hash);
    if (existing && existing.projectId !== document.projectId) {
      throw new SchemaError(`code ${index + 1} is already used by another project`);
    }
    planned.push({
      index,
      hash,
      existing,
      label: labelOf(entry, index),
      expiresAt: expiryFromAccessEntry(entry, now),
    });
  }
  const results = [];
  for (const item of planned) {
    if (item.existing && !item.existing.revokedAt) {
      const sameLabel = (item.existing.label || "") === item.label;
      const sameExpiry = item.existing.expiresAt === item.expiresAt;
      if (!sameLabel || !sameExpiry) {
        await services.store.updateCode(item.existing.id, { label: item.label, expiresAt: item.expiresAt });
        results.push({ index: item.index, status: "updated", codeId: item.existing.id });
      } else {
        results.push({ index: item.index, status: "unchanged", codeId: item.existing.id });
      }
      continue;
    }
    if (item.existing && item.existing.revokedAt) {
      results.push({ index: item.index, status: "revoked", codeId: item.existing.id });
      continue;
    }
    const id = `code_${item.hash.slice(0, 16)}`;
    await services.store.insertCode({
      id,
      lookupHash: item.hash,
      projectId: document.projectId,
      label: item.label,
      expiresAt: item.expiresAt,
    });
    results.push({ index: item.index, status: "created", codeId: id });
  }
  return { projectId: document.projectId, results };
}

export async function revokeAccessCode(services, projectId, rawCode) {
  if (!PROJECT_ID.test(projectId || "")) throw new SchemaError("invalid project id");
  const code = normalizeCode(rawCode);
  if (!isAcceptableCode(code)) throw new SchemaError("code is not usable");
  const row = await services.store.getCodeByHash(lookupHash(code, services.pepper));
  if (!row || row.projectId !== projectId) throw new SchemaError("could not revoke that code for this project");
  if (!row.revokedAt) await services.store.revokeCode(row.id);
  return { codeId: row.id, status: row.revokedAt ? "already-revoked" : "revoked" };
}

export async function rotateAccessCode(services, projectId, fromCode, toCode, entry = {}, now = Date.now()) {
  if (!PROJECT_ID.test(projectId || "")) throw new SchemaError("invalid project id");
  const current = normalizeCode(fromCode);
  const next = normalizeCode(toCode);
  if (!isAcceptableCode(current) || !isAcceptableCode(next)) throw new SchemaError("code is not usable");
  const currentRow = await services.store.getCodeByHash(lookupHash(current, services.pepper));
  if (!currentRow || currentRow.projectId !== projectId) {
    throw new SchemaError("could not revoke that code for this project");
  }
  if (current === next) return { status: "unchanged", codeId: currentRow.id };
  const nextRow = await services.store.getCodeByHash(lookupHash(next, services.pepper));
  if (nextRow && nextRow.projectId !== projectId) {
    throw new SchemaError("replacement code is already used by another project");
  }
  if (nextRow && nextRow.revokedAt) throw new SchemaError("replacement code was revoked for this project");
  let codeId = nextRow ? nextRow.id : "";
  if (!nextRow) {
    codeId = `code_${lookupHash(next, services.pepper).slice(0, 16)}`;
    await services.store.insertCode({
      id: codeId,
      lookupHash: lookupHash(next, services.pepper),
      projectId,
      label: labelOf({ label: entry.label }, 0),
      expiresAt: expiryFromAccessEntry(entry, now),
    });
  }
  if (!currentRow.revokedAt) await services.store.revokeCode(currentRow.id);
  return { status: "rotated", codeId };
}
