import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { FailClosed, SchemaError } from "./errors.js";
import { generateCode, generateId, lookupHash, mediaPath, PROJECT_ID } from "./codes.js";
import { detectMedia, MAX_MEDIA_BYTES } from "./media-types.js";
import { validatePresentation } from "./schema.js";
import { createMemoryServices } from "./runtime.js";
import { redact } from "./redact.js";
import { seedDemo } from "./demo-fixture.js";

export function loadEnvFile(env) {
  const file = env.AMC_ENV_FILE || ".env.local";
  if (!existsSync(file)) return { ...env };
  const merged = { ...env };
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (value) merged[key] = value;
  }
  return merged;
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (!arg.startsWith("--")) throw new SchemaError("Unknown argument.");
    const key = arg.slice(2);
    const value = rest[i + 1];
    if (!/^[a-z-]+$/.test(key) || value === undefined || value.startsWith("--")) throw new SchemaError("Missing value.");
    flags[key] = value;
    i += 1;
  }
  return { command, flags };
}

async function openServices(flags, env) {
  if (flags.store === "memory") {
    const services = createMemoryServices(env);
    if (flags.state) await loadState(flags.state, services);
    return services;
  }
  if (flags.store && flags.store !== "remote") throw new SchemaError("Unknown store.");
  const { assertRuntimeConfig, createRemoteServices } = await import("./runtime.js");
  const remoteEnv = { ...env, DATA_STORE: "postgres", MEDIA_STORE: "blob", VERCEL: "", NODE_ENV: env.NODE_ENV === "production" ? "production" : "development" };
  assertRuntimeConfig(remoteEnv);
  return createRemoteServices(remoteEnv);
}

async function loadState(file, services) {
  if (!existsSync(file)) return;
  const data = JSON.parse(await readFile(file, "utf8"));
  for (const project of data.projects || []) await services.store.upsertProject(project);
  for (const record of data.media || []) await services.store.putMedia(record);
  for (const fileRecord of data.files || []) {
    await services.media.put(fileRecord.pathname, Buffer.from(fileRecord.bytes, "base64"), fileRecord.contentType);
  }
  for (const code of data.codes || []) {
    if (code.code) throw new SchemaError("State file is refused.");
    const existing = await services.store.getCodeByHash(code.lookupHash);
    if (!existing) await services.store.insertCode(code);
  }
}

async function saveState(file, services) {
  if (!file || !services.store.dump) return;
  const data = services.store.dump();
  data.sessions = [];
  data.files = services.media.dump ? services.media.dump() : [];
  await mkdir(path.dirname(path.resolve(file)), { recursive: true });
  await writeFile(file, JSON.stringify(data), { mode: 0o600 });
}

function help() {
  return [
    "Developer maintenance only. This is not Allison's content handoff and it does not publish from Drive.",
    "Usage:",
    "  node scripts/projects.mjs migrate --store remote",
    "  node scripts/projects.mjs put-project --file project.json [--store memory --state data/dev.json]",
    "  node scripts/projects.mjs put-media --project id --id media-id --file image.png",
    "  node scripts/projects.mjs issue-code --project id --days 30 --label delivery",
    "  node scripts/projects.mjs revoke-code --id code-id",
    "  node scripts/projects.mjs revoke-codes --project id",
    "  node scripts/projects.mjs list --project id",
    "  node scripts/projects.mjs seed-demo",
    "",
    "Remote commands use .env.local when a value is set there, even if the shell already exported a different one. Off Vercel, a read-write token wins over an inherited VERCEL_OIDC_TOKEN. Set BLOB_AUTH=oidc only to choose that token on purpose. BLOB_PRIVATE_CANARY_SHA256 must match the private canary object.",
    "issue-code prints a new code once. It is not stored in the repo or the state file.",
    "",
  ].join("\n");
}

export async function main(argv, env = process.env, io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const writeOut = (text) => stdout.write(text);
  const writeErr = (text) => stderr.write(redact(text));
  try {
    if (argv.length === 0 || argv[0] === "help" || argv[0] === "--help") {
      writeOut(help());
      return 0;
    }
    const { command, flags } = parseArgs(argv);
    const loaded = loadEnvFile(env);
    if (command === "seed-demo" && loaded.VERCEL_ENV === "production") {
      writeErr("Demo fixture refused in production.\n");
      return 2;
    }
    const services = await openServices(flags, loaded);
    if (command === "migrate") {
      await services.store.migrate();
      writeOut("Schema is ready.\n");
    } else if (command === "put-project") {
      if (!flags.file) throw new SchemaError("Missing project file.");
      const presentation = validatePresentation(JSON.parse(await readFile(flags.file, "utf8")));
      await services.store.upsertProject(presentation);
      writeOut(`Saved project ${presentation.id}.\n`);
    } else if (command === "put-media") {
      if (!PROJECT_ID.test(flags.project || "") || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(flags.id || "") || !flags.file) {
        throw new SchemaError("Missing media arguments.");
      }
      const bytes = await readFile(flags.file);
      if (bytes.length > MAX_MEDIA_BYTES) throw new SchemaError("Media file is too large.");
      const detected = detectMedia(bytes);
      if (!detected) throw new SchemaError("Media type is not allowed.");
      const pathname = mediaPath(flags.project, flags.id);
      await services.media.put(pathname, detected.bytes, detected.contentType);
      await services.store.putMedia({
        projectId: flags.project,
        mediaId: flags.id,
        pathname,
        contentType: detected.contentType,
        filename: path.basename(flags.file).replace(/[^A-Za-z0-9._-]/g, "") || "download",
        byteLength: detected.bytes.length,
      });
      writeOut(`Saved media ${flags.project}/${flags.id}.\n`);
    } else if (command === "issue-code") {
      const days = Number(flags.days || "30");
      if (!PROJECT_ID.test(flags.project || "") || !Number.isInteger(days) || days < 1 || days > 365) {
        throw new SchemaError("Missing code arguments.");
      }
      const project = await services.store.getProject(flags.project);
      if (!project) throw new SchemaError("Unknown project.");
      const label = (flags.label || "client").replace(/[\r\n]/g, " ").slice(0, 120);
      const code = generateCode();
      const id = generateId();
      await services.store.insertCode({
        id,
        lookupHash: lookupHash(code, services.pepper),
        projectId: project.id,
        label,
        expiresAt: Date.now() + days * 24 * 60 * 60 * 1000,
      });
      writeOut(`project: ${project.id}\ncode_id: ${id}\ncode: ${code}\n`);
    } else if (command === "revoke-code") {
      if (!flags.id) throw new SchemaError("Missing code id.");
      await services.store.revokeCode(flags.id);
      writeOut(`Revoked code id ${flags.id}.\n`);
    } else if (command === "revoke-codes") {
      if (!PROJECT_ID.test(flags.project || "")) throw new SchemaError("Missing project.");
      await services.store.revokeProjectCodes(flags.project);
      writeOut(`Revoked codes for ${flags.project}.\n`);
    } else if (command === "list") {
      if (!PROJECT_ID.test(flags.project || "")) throw new SchemaError("Missing project.");
      const project = await services.store.getProject(flags.project);
      if (!project) throw new SchemaError("Unknown project.");
      writeOut(`${project.id}\t${project.fictional ? "fictional" : "client"}\t${project.title}\n`);
      for (const code of await services.store.listCodes(project.id)) {
        const state = code.revokedAt ? "revoked" : "active";
        writeOut(`code_id: ${code.id}\t${state}\texpires: ${new Date(code.expiresAt).toISOString()}\t${code.label || ""}\n`);
      }
    } else if (command === "seed-demo") {
      await seedDemo(services);
      writeOut("Seeded the fictional demo project. The non-secret fixture code is TEST_FIXTURE_CODE in lib/demo-fixture.js.\n");
    } else {
      writeErr("Unknown command.\n");
      return 1;
    }
    if (flags.state) await saveState(flags.state, services);
    return 0;
  } catch (err) {
    if (err instanceof SchemaError) {
      writeErr(`${err.message}\n`);
      return 1;
    }
    writeErr(err instanceof FailClosed ? `${err.message}\n` : "Project command failed.\n");
    return 2;
  }
}
