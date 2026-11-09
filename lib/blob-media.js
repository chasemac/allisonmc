import { FailClosed } from "./errors.js";
import { MEDIA_PATH } from "./codes.js";

function assertPath(pathname) {
  if (typeof pathname !== "string" || !MEDIA_PATH.test(pathname) || pathname.includes("..")) {
    throw new FailClosed("media path refused");
  }
}

export function createBlobMedia(client) {
  async function load() {
    if (client) return client;
    return import("@vercel/blob");
  }

  return {
    async put(pathname, bytes, contentType) {
      assertPath(pathname);
      try {
        const { put } = await load();
        const result = await put(pathname, bytes, {
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
        const { get } = await load();
        const result = await get(pathname, { access: "private", useCache: false });
        if (!result || result.statusCode !== 200 || !result.stream) return null;
        return { stream: result.stream, contentType: result.blob?.contentType || "" };
      } catch (err) {
        if (err instanceof FailClosed) throw err;
        throw new FailClosed("media store unavailable");
      }
    },
  };
}
