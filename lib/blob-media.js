import crypto from "node:crypto";
import { FailClosed } from "./errors.js";
import { MEDIA_PATH } from "./codes.js";

export const PRIVATE_CANARY_PATH = "projects/_access/private-canary";
const CANARY_PATH = /^projects\/_access\/[a-z0-9][a-z0-9-]{0,63}$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const MAX_CANARY_BYTES = 256;

function assertPath(pathname) {
  if (typeof pathname !== "string" || !MEDIA_PATH.test(pathname) || pathname.includes("..")) {
    throw new FailClosed("media path refused");
  }
}

function configured(value) {
  return typeof value === "string" ? value.trim() : "";
}

async function defaultOidcToken() {
  const { getVercelOidcToken } = await import("@vercel/oidc");
  const token = await getVercelOidcToken();
  return typeof token === "string" ? token.trim() : "";
}

export async function blobCredentials(env = {}, getOidcToken = defaultOidcToken) {
  const storeId = configured(env.BLOB_STORE_ID);
  const readWrite = configured(env.BLOB_READ_WRITE_TOKEN);
  const staticOidc = configured(env.VERCEL_OIDC_TOKEN);
  const mode = configured(env.BLOB_AUTH);
  if (mode && mode !== "oidc" && mode !== "read-write") throw new FailClosed("media store unavailable");
  if (env.VERCEL === "1") {
    if (!storeId) throw new FailClosed("media store unavailable");
    let refreshed = "";
    try {
      const value = await getOidcToken();
      refreshed = typeof value === "string" ? value.trim() : "";
    } catch {
      refreshed = "";
    }
    if (!refreshed) throw new FailClosed("media store unavailable");
    return { storeId, oidcToken: refreshed };
  }
  if (mode === "oidc") {
    if (!staticOidc || !storeId) throw new FailClosed("media store unavailable");
    return { storeId, oidcToken: staticOidc };
  }
  if (readWrite) return storeId ? { token: readWrite, storeId } : { token: readWrite };
  throw new FailClosed("media store unavailable");
}

function canaryConfig(env) {
  const pathname = configured(env.BLOB_PRIVATE_CANARY_PATH) || PRIVATE_CANARY_PATH;
  const expected = configured(env.BLOB_PRIVATE_CANARY_SHA256).toLowerCase();
  if (!CANARY_PATH.test(pathname) || pathname.includes("..") || !SHA256_HEX.test(expected)) {
    throw new FailClosed("media store unavailable");
  }
  return { pathname, expected };
}

function sameDigest(actual, expected) {
  const left = Buffer.from(actual, "hex");
  const right = Buffer.from(expected, "hex");
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

export function createBlobMedia({ env = {}, client = null, getOidcToken = defaultOidcToken } = {}) {
  async function load() {
    if (client) return client;
    return import("@vercel/blob");
  }

  async function authOptions() {
    return blobCredentials(env, getOidcToken);
  }

  return {
    async probe() {
      const auth = await authOptions();
      const { pathname, expected } = canaryConfig(env);
      const sdk = await load();
      if (typeof sdk.get !== "function") throw new FailClosed("media store unavailable");
      let result;
      try {
        result = await sdk.get(pathname, { ...auth, access: "private", useCache: false });
      } catch {
        throw new FailClosed("media store unavailable");
      }
      if (!result || result.statusCode !== 200 || !result.stream) throw new FailClosed("media store unavailable");
      const bytes = Buffer.from(await new Response(result.stream).arrayBuffer());
      if (bytes.length === 0 || bytes.length > MAX_CANARY_BYTES) throw new FailClosed("media store unavailable");
      const actual = crypto.createHash("sha256").update(bytes).digest("hex");
      if (!sameDigest(actual, expected)) throw new FailClosed("media store unavailable");
    },
    async put(pathname, bytes, contentType) {
      assertPath(pathname);
      try {
        const auth = await authOptions();
        const { put } = await load();
        const result = await put(pathname, bytes, {
          ...auth,
          access: "private",
          addRandomSuffix: false,
          allowOverwrite: true,
          contentType,
          cacheControlMaxAge: 60,
        });
        if (!result || result.pathname !== pathname) throw new FailClosed("media pathname mismatch");
        return { pathname: result.pathname };
      } catch (err) {
        if (err instanceof FailClosed) throw err;
        throw new FailClosed("media store unavailable");
      }
    },
    async get(pathname) {
      assertPath(pathname);
      try {
        const auth = await authOptions();
        const { get } = await load();
        const result = await get(pathname, { ...auth, access: "private", useCache: false });
        if (!result || result.statusCode !== 200 || !result.stream) return null;
        return { stream: result.stream, contentType: result.blob?.contentType || "" };
      } catch (err) {
        if (err instanceof FailClosed) throw err;
        throw new FailClosed("media store unavailable");
      }
    },
  };
}
