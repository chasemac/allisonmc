import { FailClosed } from "./errors.js";
import { MEDIA_PATH } from "./codes.js";

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
  if (env.VERCEL === "1" && storeId) {
    let refreshed = "";
    try {
      const value = await getOidcToken();
      refreshed = typeof value === "string" ? value.trim() : "";
    } catch {
      refreshed = "";
    }
    const oidcToken = refreshed || staticOidc;
    if (!oidcToken) throw new FailClosed("media store unavailable");
    return { storeId, oidcToken };
  }
  if (staticOidc && storeId) return { storeId, oidcToken: staticOidc };
  if (readWrite) return storeId ? { token: readWrite, storeId } : { token: readWrite };
  throw new FailClosed("media store unavailable");
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
      const sdk = await load();
      if (typeof sdk.probe === "function") return sdk.probe(auth);
      if (typeof sdk.list !== "function") throw new FailClosed("media store unavailable");
      await sdk.list({ limit: 1, ...auth });
    },
    async put(pathname, bytes, contentType) {
      assertPath(pathname);
      try {
        const auth = await authOptions();
        const { put } = await load();
        const result = await put(pathname, bytes, {
          access: "private",
          addRandomSuffix: false,
          allowOverwrite: true,
          contentType,
          cacheControlMaxAge: 60,
          ...auth,
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
        const result = await get(pathname, { access: "private", useCache: false, ...auth });
        if (!result || result.statusCode !== 200 || !result.stream) return null;
        return { stream: result.stream, contentType: result.blob?.contentType || "" };
      } catch (err) {
        if (err instanceof FailClosed) throw err;
        throw new FailClosed("media store unavailable");
      }
    },
  };
}
