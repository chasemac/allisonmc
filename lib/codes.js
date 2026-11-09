import crypto from "node:crypto";

export const PROJECT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const SECTION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const SUBMISSION_ID = /^[a-z0-9][a-z0-9_-]{0,80}$/;
export const DIGEST = /^[a-f0-9]{64}$/;
export const MEDIA_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const FRIENDLY_CODE = /^[a-z0-9](?:[a-z0-9]|[ -][a-z0-9]){5,63}$/;
const LONG_CODE = /^[a-z0-9_-]{20,200}$/;
export const CODE_PLACEHOLDER = "replace-with-a-code";

export function normalizeCode(input) {
  return String(input ?? "").normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
}

export function isAcceptableCode(input) {
  const code = normalizeCode(input);
  if (!code || code === CODE_PLACEHOLDER) return false;
  return FRIENDLY_CODE.test(code) || LONG_CODE.test(code);
}
export const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;
export const MEDIA_PATH = /^projects\/[a-z0-9][a-z0-9_-]{0,63}\/media\/[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
export const SNAP_PATH = /^projects\/[a-z0-9][a-z0-9_-]{0,63}\/snap\/[a-f0-9]{64}\/[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;

export function generateCode() {
  return crypto.randomBytes(32).toString("base64url");
}

export function generateId() {
  return crypto.randomBytes(16).toString("base64url");
}

export function lookupHash(code, pepper) {
  return crypto.createHmac("sha256", pepper).update(code).digest("hex");
}

export function sessionHash(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function mediaPath(projectId, mediaId) {
  if (!PROJECT_ID.test(projectId) || !MEDIA_ID.test(mediaId)) {
    throw new Error("media path refused");
  }
  const pathname = `projects/${projectId}/media/${mediaId}`;
  if (!MEDIA_PATH.test(pathname) || pathname.includes("..")) {
    throw new Error("media path refused");
  }
  return pathname;
}

export function snapshotMediaPath(projectId, digest, mediaId) {
  if (!PROJECT_ID.test(projectId) || !DIGEST.test(digest) || !MEDIA_ID.test(mediaId)) {
    throw new Error("media path refused");
  }
  const pathname = `projects/${projectId}/snap/${digest}/${mediaId}`;
  if (!SNAP_PATH.test(pathname) || pathname.includes("..")) throw new Error("media path refused");
  return pathname;
}

export function isStoredMediaPath(pathname) {
  return typeof pathname === "string" && !pathname.includes("..") && (MEDIA_PATH.test(pathname) || SNAP_PATH.test(pathname));
}

export function isOwnedMediaPath(projectId, mediaId, pathname) {
  if (!isStoredMediaPath(pathname)) return false;
  if (pathname === mediaPath(projectId, mediaId)) return true;
  const match = /^projects\/([^/]+)\/snap\/([a-f0-9]{64})\/([^/]+)$/.exec(pathname);
  return Boolean(match && match[1] === projectId && match[3] === mediaId);
}

export function readId(raw, pattern) {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 200) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (decoded !== raw) return null;
  if (decoded.includes("..") || decoded.includes("/") || decoded.includes("\\") || decoded.includes("\0")) {
    return null;
  }
  if (!pattern.test(decoded)) return null;
  return decoded;
}

export function timingEqualHex(left, right) {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  if (a.length !== b.length || a.length === 0) return false;
  return crypto.timingSafeEqual(a, b);
}
