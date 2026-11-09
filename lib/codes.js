import crypto from "node:crypto";

export const PROJECT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const MEDIA_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
export const CODE_SHAPE = /^[A-Za-z0-9_-]{20,200}$/;
export const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;
export const MEDIA_PATH = /^projects\/[a-z0-9][a-z0-9-]{0,63}\/media\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;

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
