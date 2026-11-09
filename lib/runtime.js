import { FailClosed } from "./errors.js";
import { createMemoryMedia, createMemoryStore } from "./memory-store.js";

function configured(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function blobConfigured(env) {
  const mode = configured(env.BLOB_AUTH);
  if (mode && mode !== "oidc" && mode !== "read-write") return false;
  const storeId = configured(env.BLOB_STORE_ID);
  const readWrite = configured(env.BLOB_READ_WRITE_TOKEN);
  const canary = configured(env.BLOB_PRIVATE_CANARY_SHA256).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(canary)) return false;
  if (env.VERCEL === "1") return Boolean(storeId);
  if (mode === "oidc") return Boolean(storeId && configured(env.VERCEL_OIDC_TOKEN));
  return Boolean(readWrite);
}

export function rateConfig(env) {
  const max = env.RATE_LIMIT_MAX === undefined || env.RATE_LIMIT_MAX === "" ? 8 : Number(env.RATE_LIMIT_MAX);
  const windowMs =
    env.RATE_LIMIT_WINDOW_MS === undefined || env.RATE_LIMIT_WINDOW_MS === ""
      ? 10 * 60 * 1000
      : Number(env.RATE_LIMIT_WINDOW_MS);
  if (!Number.isInteger(max) || max < 1 || max > 100) throw new FailClosed("rate limit config refused");
  if (!Number.isInteger(windowMs) || windowMs < 60_000 || windowMs > 86_400_000) {
    throw new FailClosed("rate limit config refused");
  }
  const globalMax =
    env.RATE_LIMIT_GLOBAL_MAX === undefined || env.RATE_LIMIT_GLOBAL_MAX === "" ? max * 10 : Number(env.RATE_LIMIT_GLOBAL_MAX);
  if (!Number.isInteger(globalMax) || globalMax < max || globalMax > 10_000) {
    throw new FailClosed("rate limit config refused");
  }
  return { max, windowMs, globalMax };
}

export function assertRuntimeConfig(env) {
  if (env.VERCEL_ENV === "preview") throw new FailClosed("preview is closed");
  if (env.VERCEL === "1" && env.VERCEL_ENV !== "production") throw new FailClosed("stores not configured");
  if (env.DEMO_FIXTURE === "1" && env.VERCEL_ENV === "production") {
    throw new FailClosed("demo fixture refused in production");
  }
  const hosted = env.VERCEL === "1" || env.NODE_ENV === "production";
  const dataStore = env.DATA_STORE || "";
  const mediaStore = env.MEDIA_STORE || "";
  if (dataStore === "memory" || mediaStore === "memory") {
    if (hosted || dataStore !== "memory" || mediaStore !== "memory") {
      throw new FailClosed("memory store refused");
    }
    if (!env.CODE_PEPPER || env.CODE_PEPPER.length < 32) throw new FailClosed("code pepper missing");
    return { mode: "memory" };
  }
  if (dataStore === "" && mediaStore === "") throw new FailClosed("stores not configured");
  if (dataStore !== "postgres" || mediaStore !== "blob") {
    throw new FailClosed(hosted ? "stores not configured" : "unsupported store");
  }
  if (!env.DATABASE_URL) throw new FailClosed("database not configured");
  if (!env.CODE_PEPPER || String(env.CODE_PEPPER).length < 32) throw new FailClosed("code pepper missing");
  if (!blobConfigured(env)) throw new FailClosed("media store not configured");
  return { mode: "remote" };
}

export function createMemoryServices(env) {
  if (!env.CODE_PEPPER || env.CODE_PEPPER.length < 32) throw new FailClosed("code pepper missing");
  return {
    pepper: env.CODE_PEPPER,
    store: createMemoryStore(),
    media: createMemoryMedia(),
  };
}

export async function createRemoteServices(env) {
  const { neon } = await import("@neondatabase/serverless");
  const { createPostgresStore } = await import("./postgres-store.js");
  const { createBlobMedia } = await import("./blob-media.js");
  return {
    pepper: env.CODE_PEPPER,
    store: createPostgresStore(neon(env.DATABASE_URL)),
    media: createBlobMedia({ env }),
  };
}

let cache = null;

export function clearServiceCache() {
  cache = null;
}

export async function loadServices(env) {
  const config = assertRuntimeConfig(env);
  const key = `${config.mode}:${env.DEMO_FIXTURE || ""}:${env.DATABASE_URL ? "db" : ""}:${env.BLOB_STORE_ID || ""}`;
  if (cache && cache.key === key) return cache.services;
  const services = config.mode === "memory" ? createMemoryServices(env) : await createRemoteServices(env);
  cache = { key, services };
  return services;
}
