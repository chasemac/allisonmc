export const MAX_JSON_BYTES = 2048;
export const PRIVATE_NO_STORE = "private, no-store";
export const BODY_TOO_LARGE = Symbol("body-too-large");
export const PAGE_PERMISSIONS = "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()";
export const PAGE_CSP = [
  "default-src 'self'",
  "img-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "script-src 'self'",
  "connect-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "worker-src 'none'",
  "manifest-src 'none'",
  "media-src 'none'",
].join("; ");

const SESSION_CAP_SECONDS = 12 * 60 * 60;
const IP_TOKEN = /^[A-Za-z0-9:.]{1,80}$/;
const LOCKED_HEADERS = new Set([
  "cache-control",
  "content-security-policy",
  "content-type",
  "referrer-policy",
  "x-content-type-options",
  "x-robots-tag",
]);
const HOP_BY_HOP = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const UNTRUSTED_FORWARDING = new Set([
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-proto",
  "x-real-ip",
  "x-vercel-forwarded-for",
  "x-vercel-id",
]);

export function json(status, body, extra = {}) {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": PRIVATE_NO_STORE,
    "x-content-type-options": "nosniff",
    "x-robots-tag": "noindex",
    "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'none'; sandbox",
  });
  for (const [key, value] of Object.entries(extra)) {
    if (LOCKED_HEADERS.has(key.toLowerCase())) continue;
    headers.set(key, value);
  }
  return new Response(JSON.stringify(body), { status, headers });
}

export function pageResponseHeaders(contentType) {
  return {
    "content-type": contentType,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    "permissions-policy": PAGE_PERMISSIONS,
    "content-security-policy": PAGE_CSP,
  };
}

export function normalizeIpToken(value) {
  let candidate = String(value || "").trim();
  if (candidate.toLowerCase().startsWith("::ffff:")) candidate = candidate.slice("::ffff:".length);
  return IP_TOKEN.test(candidate) ? candidate : "";
}

function firstIp(value) {
  if (!value) return "";
  return normalizeIpToken(String(value).split(",")[0]);
}

export function clientIp(request) {
  // Vercel sets x-vercel-forwarded-for and overwrites a client value.
  // When it is present, a client-supplied x-forwarded-for must not choose the bucket.
  if (request.headers.has("x-vercel-forwarded-for")) {
    return firstIp(request.headers.get("x-vercel-forwarded-for")) || "unknown";
  }
  return firstIp(request.headers.get("x-forwarded-for")) || firstIp(request.headers.get("x-real-ip")) || "unknown";
}

export function forwardedClientHeaders(nodeHeaders, remoteAddress) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(nodeHeaders || {})) {
    if (HOP_BY_HOP.has(key) || UNTRUSTED_FORWARDING.has(key)) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item) headers.append(key, item);
      }
    } else if (value) headers.set(key, value);
  }
  headers.set("x-forwarded-for", normalizeIpToken(remoteAddress) || "unknown");
  return headers;
}

function cookieValues(header, name) {
  if (!header || !name) return [];
  const values = [];
  for (const part of String(header).split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) values.push(part.slice(index + 1).trim());
  }
  return values;
}

export function readCookie(header, name) {
  const values = cookieValues(header, name);
  return values.length === 1 ? values[0] : "";
}

export function hasCookieName(header, name) {
  return cookieValues(header, name).length > 0;
}

export function requestIsSecure(request) {
  try {
    if (new URL(request.url).protocol === "https:") return true;
  } catch {
    // A malformed URL is not evidence of HTTPS.
  }
  const proto = request.headers.get("x-forwarded-proto");
  if (!proto) return false;
  const hops = proto.split(",").map((part) => part.trim().toLowerCase()).filter(Boolean);
  return hops.length > 0 && hops[hops.length - 1] === "https";
}

function cookieLifetime(expiresAt) {
  const remaining = Number(expiresAt) - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0) return 0;
  return Math.min(SESSION_CAP_SECONDS, Math.floor(remaining / 1000));
}

export function sessionCookie(token, expiresAt, request) {
  const maxAge = cookieLifetime(expiresAt);
  const parts = [
    `amc_session=${token}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Strict",
    `Max-Age=${maxAge}`,
    `Expires=${new Date(Date.now() + maxAge * 1000).toUTCString()}`,
  ];
  if (requestIsSecure(request)) parts.push("Secure");
  return parts.join("; ");
}

export function clearCookie(request) {
  const parts = [
    "amc_session=",
    "HttpOnly",
    "Path=/",
    "SameSite=Strict",
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
  ];
  if (requestIsSecure(request)) parts.push("Secure");
  return parts.join("; ");
}

export function contentLengthOver(request, max = MAX_JSON_BYTES) {
  const header = request.headers.get("content-length");
  if (header === null) return false;
  const value = header.trim();
  if (!/^\d{1,12}$/.test(value)) return false;
  return Number(value) > max;
}

export async function readLimitedBuffer(iterable, max) {
  const chunks = [];
  let total = 0;
  for await (const chunk of iterable) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > max) return BODY_TOO_LARGE;
    chunks.push(buffer);
  }
  return chunks.length ? Buffer.concat(chunks) : Buffer.alloc(0);
}

export async function readJsonObject(request, max = MAX_JSON_BYTES) {
  const header = request.headers.get("content-length");
  if (header !== null && !/^\d{1,12}$/.test(header.trim())) return null;
  if (contentLengthOver(request, max)) return BODY_TOO_LARGE;
  if (header !== null && Number(header.trim()) === 0) return null;
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => {});
        return BODY_TOO_LARGE;
      }
      chunks.push(Buffer.from(value));
    }
  } catch {
    return null;
  }
  if (total === 0) return null;
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}
