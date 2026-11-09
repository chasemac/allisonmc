export function json(status, body, extra = {}) {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
    "x-robots-tag": "noindex",
    "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'none'; sandbox",
  });
  for (const [key, value] of Object.entries(extra)) headers.set(key, value);
  return new Response(JSON.stringify(body), { status, headers });
}

export function clientIp(request) {
  const forwarded = request.headers.get("x-forwarded-for");
  const candidate = (forwarded ? forwarded.split(",")[0] : request.headers.get("x-real-ip") || "").trim();
  if (!/^[A-Za-z0-9:.]{1,80}$/.test(candidate)) return "unknown";
  return candidate;
}

export function readCookie(header, name) {
  if (!header) return "";
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return "";
}

export function requestIsSecure(request) {
  const proto = request.headers.get("x-forwarded-proto");
  if (proto) return proto.split(",")[0].trim() === "https";
  return new URL(request.url).protocol === "https:";
}

export function sessionCookie(token, expiresAt, request) {
  const maxAge = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
  const parts = [`amc_session=${token}`, "HttpOnly", "Path=/", "SameSite=Strict", `Max-Age=${maxAge}`];
  if (requestIsSecure(request)) parts.push("Secure");
  return parts.join("; ");
}

export function clearCookie(request) {
  const parts = ["amc_session=", "HttpOnly", "Path=/", "SameSite=Strict", "Max-Age=0"];
  if (requestIsSecure(request)) parts.push("Secure");
  return parts.join("; ");
}

export async function readJsonObject(request, max = 2048) {
  const declared = Number(request.headers.get("content-length") || "0");
  if (Number.isFinite(declared) && declared > max) return null;
  if (!request.body) return null;
  const bytes = Buffer.from(await request.arrayBuffer());
  if (bytes.length === 0 || bytes.length > max) return null;
  try {
    const parsed = JSON.parse(bytes.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}
