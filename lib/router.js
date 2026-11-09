import { FailClosed } from "./errors.js";
import {
  isAcceptableCode,
  normalizeCode,
  MEDIA_ID,
  PROJECT_ID,
  TOKEN_SHAPE,
  lookupHash,
  isOwnedMediaPath,
  snapshotMediaPath,
  readId,
  sessionHash,
  timingEqualHex,
} from "./codes.js";
import { WIDGET_CSP, widgetProblems } from "./content-policy.js";
import { ALLOWED_MEDIA_TYPES, safeFilename } from "./media-types.js";
import {
  BODY_TOO_LARGE,
  MAX_JSON_BYTES,
  PRIVATE_NO_STORE,
  clearCookie,
  clientIp,
  contentLengthOver,
  hasCookieName,
  json,
  readCookie,
  readJsonObject,
  sessionCookie,
} from "./http.js";
import { redact } from "./redact.js";
import { loadServices, rateConfig } from "./runtime.js";

const SESSION_MS = 12 * 60 * 60 * 1000;
const DUMMY_CODE = "not-a-real-share-code";

function defaultLog(message) {
  console.error(redact(message));
}

function requestPath(request) {
  const url = new URL(request.url);
  let pathname = url.pathname;
  if (pathname.length > 1 && pathname.endsWith("/")) pathname = pathname.slice(0, -1);
  return pathname;
}

async function limitAccess(request, services, env) {
  const config = rateConfig(env);
  const now = Date.now();
  const consume = async (bucket, max) => {
    try {
      return await services.store.consumeRateLimit(bucket, { max, windowMs: config.windowMs, now });
    } catch (err) {
      if (err instanceof FailClosed) throw err;
      throw new FailClosed("rate limit store unavailable");
    }
  };
  const perAddress = await consume(`access:ip:${clientIp(request)}`, config.max);
  if (!perAddress.allowed) return perAddress;
  // The shared cap is off unless RATE_LIMIT_GLOBAL_MAX is set: a default cap would let anyone lock real clients out.
  if (config.globalMax === 0) return perAddress;
  return consume("access:global", config.globalMax);
}

function isJsonContentType(value) {
  const type = String(value || "").toLowerCase().trim();
  if (!type.startsWith("application/json")) return false;
  const rest = type.slice("application/json".length);
  return rest === "" || rest[0] === ";" || rest[0] === " " || rest[0] === "\t";
}

async function postAccess(request, services, env, log) {
  const url = new URL(request.url);
  const leaked = url.searchParams.has("code");
  if (request.method !== "POST" && !leaked) {
    return json(405, { error: "Use the project form." }, { allow: "POST" });
  }
  if (request.method === "POST" && contentLengthOver(request, MAX_JSON_BYTES)) {
    return json(413, { error: "Request is too large." });
  }
  const limit = await limitAccess(request, services, env);
  if (!limit.allowed) {
    return json(429, { error: "Too many attempts. Try again later." }, { "retry-after": "60" });
  }
  if (leaked || request.method !== "POST") {
    log("rejected code in url");
    return json(400, { error: "Enter the code in the form." });
  }
  if (!isJsonContentType(request.headers.get("content-type"))) return json(415, { error: "Enter the code in the form." });
  const body = await readJsonObject(request, MAX_JSON_BYTES);
  if (body === BODY_TOO_LARGE) return json(413, { error: "Request is too large." });
  const code = normalizeCode(body && typeof body.code === "string" ? body.code : "");
  if (!isAcceptableCode(code)) return json(400, { error: "Enter a valid code." });

  const computed = lookupHash(code, services.pepper);
  let row = null;
  try {
    row = await services.store.getCodeByHash(computed);
  } catch (err) {
    if (err instanceof FailClosed) throw err;
    throw new FailClosed("project store unavailable");
  }
  const dummy = lookupHash(DUMMY_CODE, services.pepper);
  const compared = row ? row.lookupHash : dummy;
  // Both comparisons always run so a stored hit does not skip a hash compare.
  const equalStored = timingEqualHex(computed, compared);
  const equalDummy = timingEqualHex(dummy, dummy);
  const matched = Boolean(row) && equalStored && equalDummy;
  if (!matched) {
    log("access denied unknown");
    return json(401, { error: "That code is not valid." });
  }
  const now = Date.now();
  if (row.revokedAt) {
    log("access denied revoked");
    return json(401, { error: "This code has been revoked." });
  }
  if (row.expiresAt <= now) {
    log("access denied expired");
    return json(401, { error: "This code has expired." });
  }
  const project = await services.store.getProject(row.projectId);
  if (!project) {
    log("access denied missing project");
    return json(401, { error: "That code is not valid." });
  }
  try {
    if (typeof services.media.probe !== "function") throw new FailClosed("media store unavailable");
    await services.media.probe();
  } catch (err) {
    if (err instanceof FailClosed) throw err;
    throw new FailClosed("media store unavailable");
  }
  const token = (await import("node:crypto")).randomBytes(32).toString("base64url");
  const expiresAt = Math.min(now + SESSION_MS, row.expiresAt);
  await services.store.insertSession({
    idHash: sessionHash(token),
    projectId: row.projectId,
    codeId: row.id,
    expiresAt,
  });
  const response = json(200, { project });
  response.headers.append("set-cookie", sessionCookie(token, expiresAt, request));
  return response;
}

async function requireSession(request, services) {
  const token = readCookie(request.headers.get("cookie"), "amc_session");
  if (!TOKEN_SHAPE.test(token)) return null;
  let session;
  let code;
  try {
    session = await services.store.getSession(sessionHash(token));
    if (!session) return null;
    code = await services.store.getCodeById(session.codeId);
  } catch (err) {
    if (err instanceof FailClosed) throw err;
    throw new FailClosed("session store unavailable");
  }
  const now = Date.now();
  if (session.revokedAt || session.expiresAt <= now) return null;
  if (!code || code.revokedAt || code.expiresAt <= now || code.projectId !== session.projectId) return null;
  return session;
}

function withClearedCookie(request, response) {
  if (hasCookieName(request.headers.get("cookie"), "amc_session")) {
    response.headers.append("set-cookie", clearCookie(request));
  }
  return response;
}

async function authorizedProject(request, services, projectId) {
  const session = await requireSession(request, services);
  if (!session) return { error: withClearedCookie(request, json(401, { error: "Your session has ended." })) };
  if (session.projectId !== projectId) return { error: json(404, { error: "Not found." }) };
  return { session };
}

async function logout(request, services) {
  if (request.method !== "POST") return json(405, { error: "Use the project form." }, { allow: "POST" });
  const token = readCookie(request.headers.get("cookie"), "amc_session");
  if (TOKEN_SHAPE.test(token)) {
    try {
      await services.store.revokeSession(sessionHash(token));
    } catch (err) {
      if (err instanceof FailClosed) throw err;
      throw new FailClosed("session store unavailable");
    }
  }
  const response = json(200, { ok: true });
  response.headers.append("set-cookie", clearCookie(request));
  return response;
}

async function currentSession(request, services) {
  if (request.method !== "GET") return json(405, { error: "Use the project form." }, { allow: "GET" });
  const session = await requireSession(request, services);
  if (!session) return withClearedCookie(request, json(200, { authenticated: false }));
  const project = await services.store.getProject(session.projectId);
  if (!project) return withClearedCookie(request, json(200, { authenticated: false }));
  return json(200, { authenticated: true, project });
}

function mediaHeaders(record, disposition) {
  const filename = safeFilename(record.filename) || "download";
  return {
    "content-type": record.contentType,
    "x-content-type-options": "nosniff",
    "cache-control": PRIVATE_NO_STORE,
    "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'none'; sandbox",
    "cross-origin-resource-policy": "same-origin",
    "x-robots-tag": "noindex",
    "accept-ranges": "none",
    "content-disposition": disposition === "attachment" ? `attachment; filename="${filename}"` : "inline",
  };
}

async function recordFor(services, projectId, mediaId) {
  const publication = await services.store.getPublication(projectId);
  if (!publication) return services.store.getMedia(projectId, mediaId);
  const snapshot = await services.store.getSnapshot(projectId, publication.submissionId);
  if (!snapshot || snapshot.digest !== publication.digest) throw new FailClosed("published snapshot refused");
  const file = snapshot.files.find((item) => item.mediaId === mediaId);
  if (!file) return null;
  return {
    projectId,
    mediaId,
    pathname: snapshotMediaPath(projectId, snapshot.digest, mediaId),
    contentType: file.contentType,
    filename: file.filename,
    byteLength: file.size,
  };
}

async function streamMedia(record, services, disposition) {
  if (!ALLOWED_MEDIA_TYPES.has(record.contentType)) throw new FailClosed("media type refused");
  if (!isOwnedMediaPath(record.projectId, record.mediaId, record.pathname)) {
    throw new FailClosed("media path refused");
  }
  if (record.contentType === "text/html") return json(404, { error: "Not found." });
  let file;
  try {
    file = await services.media.get(record.pathname);
  } catch (err) {
    if (err instanceof FailClosed) throw err;
    throw new FailClosed("media store unavailable");
  }
  if (!file) return json(404, { error: "Not found." });
  return new Response(file.stream || file.bytes, { status: 200, headers: mediaHeaders(record, disposition) });
}

async function route(request, services, env, log) {
  const pathname = requestPath(request);
  if (pathname === "/api/access") return postAccess(request, services, env, log);
  if (pathname === "/api/logout") return logout(request, services);
  if (pathname === "/api/session") return currentSession(request, services);

  const presentation = pathname.match(/^\/api\/projects\/([^/]+)\/presentation$/);
  const widgetOpen = pathname.match(/^\/api\/projects\/([^/]+)\/widgets\/([^/]+)\/open$/);
  const media = pathname.match(/^\/api\/projects\/([^/]+)\/media\/([^/]+)$/);
  const attachment = pathname.match(/^\/api\/projects\/([^/]+)\/attachments\/([^/]+)$/);
  const match = presentation || widgetOpen || media || attachment;
  if (!match) return json(404, { error: "Not found." });

  const projectId = readId(match[1], PROJECT_ID);
  if (!projectId) return json(400, { error: "Not found." });
  const auth = await authorizedProject(request, services, projectId);
  if (auth.error) return auth.error;

  if (widgetOpen) {
    if (request.method !== "GET") return json(405, { error: "Not found." }, { allow: "GET" });
    const mediaId = readId(match[2], MEDIA_ID);
    if (!mediaId) return json(400, { error: "Not found." });
    const project = await services.store.getProject(projectId);
    const referenced = project?.sections.some((section) =>
      section.blocks.some((block) => block.type === "widget" && block.mediaId === mediaId),
    );
    if (!referenced) return json(404, { error: "Not found." });
    const record = await recordFor(services, projectId, mediaId);
    if (!record || record.contentType !== "text/html") return json(404, { error: "Not found." });
    if (!isOwnedMediaPath(projectId, mediaId, record.pathname)) throw new FailClosed("media path refused");
    if (record.byteLength > 20 * 1024 * 1024) return json(404, { error: "Not found." });
    const file = await services.media.get(record.pathname);
    if (!file) return json(404, { error: "Not found." });
    const bytes = Buffer.from(await new Response(file.stream || file.bytes).arrayBuffer());
    if (bytes.length > 20 * 1024 * 1024 || widgetProblems(bytes).length) return json(404, { error: "Not found." });
    return new Response(bytes, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": WIDGET_CSP,
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "cache-control": PRIVATE_NO_STORE,
        "x-robots-tag": "noindex",
        "accept-ranges": "none",
      },
    });
  }

  if (presentation) {
    if (request.method !== "GET") return json(405, { error: "Not found." }, { allow: "GET" });
    const project = await services.store.getProject(projectId);
    if (!project) return json(404, { error: "Not found." });
    return json(200, { project });
  }

  if (media) {
    if (request.method !== "GET") return json(405, { error: "Not found." }, { allow: "GET" });
    const mediaId = readId(match[2], MEDIA_ID);
    if (!mediaId) return json(400, { error: "Not found." });
    const record = await recordFor(services, projectId, mediaId);
    if (!record) return json(404, { error: "Not found." });
    const download = record.contentType === "application/pdf" || record.contentType === "model/vnd.collada+xml";
    return streamMedia(record, services, download ? "attachment" : "inline");
  }

  if (request.method !== "GET") return json(405, { error: "Not found." }, { allow: "GET" });
  const attachmentId = readId(match[2], MEDIA_ID);
  if (!attachmentId) return json(400, { error: "Not found." });
  const project = await services.store.getProject(projectId);
  const item = project?.attachments.find((entry) => entry.id === attachmentId);
  if (!item || item.kind !== "file") return json(404, { error: "Not found." });
  const record = await recordFor(services, projectId, item.mediaId);
  if (!record) return json(404, { error: "Not found." });
  return streamMedia({ ...record, filename: item.filename }, services, "attachment");
}

export async function handle(request, options = {}) {
  const env = options.env || process.env;
  const log = options.log || defaultLog;
  try {
    const services = options.services || (await loadServices(env));
    if (!services.pepper || services.pepper.length < 32) throw new FailClosed("code pepper missing");
    return await route(request, services, env, log);
  } catch (err) {
    const detail = err instanceof Error && err.message ? err.message : "unexpected failure";
    log(redact(detail));
    return json(503, { error: "Project access is unavailable." });
  }
}
