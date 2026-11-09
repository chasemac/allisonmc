import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { FailClosed, SchemaError } from "./errors.js";
import { importAccessFile, revokeAccessCode, rotateAccessCode } from "./access-codes.js";
import { DIGEST, generateCode, generateId, lookupHash, mediaPath, PROJECT_ID, SUBMISSION_ID } from "./codes.js";
import { importDriveSnapshot } from "./drive-import.js";
import { approveSnapshot, assertPublishable, deriveStrippedSnapshot, inspectSnapshot, publishSnapshot, rollbackSnapshot, sealSnapshot } from "./ingest.js";
import { detectMedia, MAX_MEDIA_BYTES } from "./media-types.js";
import { validatePresentation } from "./schema.js";
import { createMemoryServices } from "./runtime.js";
import { redact } from "./redact.js";
import { seedDemo } from "./demo-fixture.js";

function receiptCell(value) {
  return redact(String(value).replace(/[\t\r\n]+/g, " "));
}

function assetReceipt(inspected) {
  const lines = ["assets:", "path\trole\tsize\tsha256\tproblems"];
  const assets = [...inspected.mapped.assets].sort((left, right) => left.path.localeCompare(right.path));
  for (const asset of assets) {
    const listed = inspected.listed.get(asset.path);
    const size = listed ? listed.size : asset.bytes.length;
    const shortHash = String(listed ? listed.sha256 : "").slice(0, 12);
    const problems = Array.isArray(asset.problems) && asset.problems.length
      ? receiptCell(asset.problems.join(" | "))
      : "none";
    lines.push([asset.path, asset.role, size, shortHash, problems].join("\t"));
  }
  return lines;
}

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

const BOOLEAN_FLAGS = new Set(["seal"]);

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (!arg.startsWith("--")) throw new SchemaError("Unknown argument.");
    const key = arg.slice(2);
    if (!/^[a-z-]+$/.test(key)) throw new SchemaError("Missing value.");
    if (BOOLEAN_FLAGS.has(key)) {
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("--")) throw new SchemaError("Unexpected value.");
      flags[key] = true;
      continue;
    }
    const value = rest[i + 1];
    if (value === undefined || value.startsWith("--")) throw new SchemaError("Missing value.");
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
  for (const snapshot of data.snapshots || []) await services.store.importSnapshot(snapshot);
  for (const approval of data.approvals || []) await services.store.putApproval(approval);
  for (const publication of data.publications || []) await services.store.importPublication(publication);
}

async function saveState(file, services) {
  if (!file || !services.store.dump) return;
  const data = services.store.dump();
  data.sessions = [];
  data.files = services.media.dump ? services.media.dump() : [];
  await mkdir(path.dirname(path.resolve(file)), { recursive: true });
  await writeFile(file, JSON.stringify(data), { mode: 0o600 });
}

function reportInspection(inspected) {
  let problem = "";
  try {
    assertPublishable(inspected);
  } catch (err) {
    if (!(err instanceof SchemaError)) throw err;
    problem = err.message;
  }
  const roles = {};
  for (const asset of inspected.mapped.assets) roles[asset.role] = (roles[asset.role] || 0) + 1;
  return [
    `project: ${inspected.ready.projectId}`,
    `submission: ${inspected.ready.submissionId}`,
    `snapshotDigest: ${inspected.digest}`,
    `manifestDigest: ${inspected.manifestDigest || ""}`,
    `manifestDigestMatches: ${inspected.manifestDigestMatches === null ? "absent" : inspected.manifestDigestMatches}`,
    `files: ${inspected.listed.size}`,
    `publishable: ${problem ? "no" : "yes"}`,
    problem ? `problem: ${receiptCell(problem)}` : "",
    `roles: ${JSON.stringify(roles)}`,
    "published: false",
    ...assetReceipt(inspected),
  ].filter((line) => line !== "").join("\n");
}

function reportStaged(staged, sealResult) {
  const lines = [
    reportInspection(staged.inspected),
    `staged: ${staged.out}`,
    `sealed: ${sealResult ? "true" : "false"}`,
  ];
  if (sealResult) lines.push(`idempotent: ${sealResult.idempotent}`);
  return `${lines.join("\n")}\n`;
}

function assertImportFlags(flags) {
  const allowed = new Set(flags.seal ? ["dir", "out", "seal", "store", "state"] : ["dir", "out"]);
  for (const key of Object.keys(flags)) {
    if (!allowed.has(key)) throw new SchemaError("Unknown argument.");
  }
  if (!flags.dir) throw new SchemaError("Missing snapshot directory.");
  if (!flags.out) throw new SchemaError("Missing output directory.");
}

function help() {
  return [
    "Developer maintenance only. Editing the Allison Site Inbox Drive folder does not activate codes or publish files.",
    "The folder name is not a project id. Do not copy a submission or a plaintext code into git, logs, or chat.",
    "Remote commands require AMC_TARGET=production and the production DATABASE_URL, CODE_PEPPER, and Blob settings.",
    "Preview and production use different peppers. Do not run a preview pepper against the shared database.",
    "Neon stays on the Free plan. Do not upgrade it.",
    "Usage:",
    "  AMC_TARGET=production node scripts/projects.mjs migrate --store remote",
    "  AMC_TARGET=production node scripts/projects.mjs register-project --store remote --project id --title \"Title\"",
    "  node scripts/projects.mjs import-drive --dir /path/to/drive-snapshot --out /path/to/fresh-stage",
    "  node scripts/projects.mjs import-drive --dir /path/to/drive-snapshot --out /path/to/fresh-stage --seal --store memory",
    "  node scripts/projects.mjs inspect --dir /path/to/snapshot",
    "  node scripts/projects.mjs derive --dir /path/to/original --out /path/to/derived --submission new-submission-id",
    "  AMC_TARGET=production node scripts/projects.mjs seal --store remote --dir /path/to/snapshot",
    "  AMC_TARGET=production node scripts/projects.mjs approve --store remote --project id --submission id --digest digest --operation publish",
    "  AMC_TARGET=production node scripts/projects.mjs publish --store remote --project id --submission id --digest digest",
    "  AMC_TARGET=production node scripts/projects.mjs rollback --store remote --project id --submission id --digest digest",
    "  AMC_TARGET=production node scripts/projects.mjs import-codes --store remote --file /path/to/project-access.json",
    "  AMC_TARGET=production node scripts/projects.mjs revoke-code --store remote --project id --code \"client code\"",
    "  AMC_TARGET=production node scripts/projects.mjs rotate-code --store remote --project id --from \"old code\" --to \"new code\"",
    "  AMC_TARGET=production node scripts/projects.mjs issue-code --store remote --project id --days 30 --label delivery",
    "  AMC_TARGET=production node scripts/projects.mjs revoke-code --store remote --id code-id",
    "  AMC_TARGET=production node scripts/projects.mjs list --store remote --project id",
    "  node scripts/projects.mjs seed-demo --store memory",
    "",
    "Publish path: import-drive or inspect, then seal, approve --operation publish, publish. Use the printed snapshotDigest.",
    "import-drive copies a local Drive snapshot into a fresh directory, checks READY.json, and prints the inspect receipt.",
    "It does not approve or publish. There is no watcher. A file that changes between two scans stops the command: still syncing, try again.",
    "--seal may seal the staged copy. approve and publish stay separate and still require the printed snapshotDigest.",
    "A project-access.json in the submission is refused. Codes stay in the separate access file. import-drive does not read or print them.",
    "A correction is a new submission id. Repeating publish of the same digest is a no-op. Rollback does not restore codes.",
    "inspect prints snapshotDigest, publishable, and a tab-separated asset table: path, role, size, a 12-character sha256, and problems. It does not print codes, notes, or file bytes. A database URL, pepper, session cookie, or JSON code inside a problem is redacted. seal prints snapshotDigest, idempotent, and published: false.",
    "approve prints approved and published: false. publish prints version, idempotent, published: true, and codesChanged: false.",
    "derive writes DERIVED.json and a new submission. It leaves the original directory unchanged and does not publish.",
    "import-codes reads the Drive copy of the access file. It does not print codes. Do not import templates/project-access.json.",
    "issue-code prints a new code once. Do not commit that output.",
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
    if (command === "import-drive") {
      assertImportFlags(flags);
      if (!flags.seal) {
        const staged = await importDriveSnapshot(flags.dir, flags.out);
        writeOut(reportStaged(staged, null));
        return 0;
      }
    }
    const loaded = loadEnvFile(env);
    if (command === "inspect") {
      if (!flags.dir) throw new SchemaError("Missing snapshot directory.");
      writeOut(reportInspection(await inspectSnapshot(flags.dir)));
      return 0;
    }
    if (command === "derive") {
      const result = await deriveStrippedSnapshot(flags.dir, flags.out, flags.submission);
      writeOut(`inputDigest: ${result.inputDigest}\noutputDigest: ${result.outputDigest}\npublished: false\n`);
      return 0;
    }
    if (command === "seed-demo" && (loaded.VERCEL_ENV === "production" || loaded.AMC_TARGET === "production")) {
      writeErr("Demo fixture refused in production.\n");
      return 2;
    }
    if ((flags.store || "remote") !== "memory" && loaded.VERCEL_ENV === "preview") {
      writeErr("Preview cannot use production data or media. Maintenance was not started.\n");
      return 1;
    }
    if ((flags.store || "remote") !== "memory" && loaded.AMC_TARGET !== "production") {
      writeErr("Remote maintenance requires AMC_TARGET=production and production credentials. Preview credentials are not accepted.\n");
      return 1;
    }
    const services = await openServices(flags, loaded);
    if (command === "migrate") {
      await services.store.migrate();
      writeOut("Schema is ready.\n");
    } else if (command === "put-project") {
      if (!flags.file) throw new SchemaError("Missing project file.");
      const presentation = validatePresentation(JSON.parse(await readFile(flags.file, "utf8")));
      if (await services.store.getPublication(presentation.id)) throw new SchemaError("published project is unchanged");
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
      if (flags.code) {
        const result = await revokeAccessCode(services, flags.project, flags.code);
        writeOut(`code_id: ${result.codeId}\nstatus: ${result.status}\n`);
      } else if (flags.id) {
        await services.store.revokeCode(flags.id);
        writeOut(`Revoked code id ${flags.id}.\n`);
      } else {
        throw new SchemaError("Missing code id.");
      }
    } else if (command === "rotate-code") {
      const result = await rotateAccessCode(services, flags.project, flags.from, flags.to, {
        label: flags.label,
        expiresOn: flags["expires-on"],
      });
      writeOut(`code_id: ${result.codeId}\nstatus: ${result.status}\n`);
    } else if (command === "register-project") {
      if (!PROJECT_ID.test(flags.project || "") || !flags.title) throw new SchemaError("Missing project registration.");
      const existing = await services.store.getProject(flags.project);
      if (existing) {
        writeOut(`Registered ${existing.id}. Existing presentation was left unchanged.\n`);
      } else {
        const presentation = validatePresentation({
          id: flags.project,
          title: flags.title,
          summary: "Registered for private viewing. No submission is published yet.",
          fictional: false,
          sections: [{
            id: "pending",
            title: "Pending",
            blocks: [{ type: "text", text: "This project is registered and has no published submission." }],
          }],
          attachments: [],
        });
        await services.store.upsertProject(presentation);
        writeOut(`Registered ${presentation.id}. Nothing is published.\n`);
      }
    } else if (command === "import-codes") {
      if (!flags.file) throw new SchemaError("Missing access file.");
      const document = JSON.parse(await readFile(flags.file, "utf8"));
      const result = await importAccessFile(services, document);
      const counts = { created: 0, unchanged: 0, updated: 0, revoked: 0 };
      for (const item of result.results) counts[item.status] += 1;
      writeOut(`project: ${result.projectId}\ncreated: ${counts.created}\nunchanged: ${counts.unchanged}\nupdated: ${counts.updated}\nleft_revoked: ${counts.revoked}\n`);
    } else if (command === "seal") {
      if (!flags.dir) throw new SchemaError("Missing snapshot directory.");
      const inspected = await inspectSnapshot(flags.dir);
      const result = await sealSnapshot(services, inspected);
      writeOut(`snapshotDigest: ${result.digest}\nidempotent: ${result.idempotent}\npublished: false\n`);
    } else if (command === "approve") {
      if (!PROJECT_ID.test(flags.project || "") || !SUBMISSION_ID.test(flags.submission || "") || !DIGEST.test(flags.digest || "")) {
        throw new SchemaError("Missing approval.");
      }
      const result = await approveSnapshot(services, {
        projectId: flags.project,
        submissionId: flags.submission,
        digest: flags.digest,
        operation: flags.operation,
      });
      writeOut(`approved: ${result.approved}\npublished: false\n`);
    } else if (command === "publish" || command === "rollback") {
      if (!PROJECT_ID.test(flags.project || "") || !SUBMISSION_ID.test(flags.submission || "") || !DIGEST.test(flags.digest || "")) {
        throw new SchemaError("Missing snapshot.");
      }
      const run = command === "publish" ? publishSnapshot : rollbackSnapshot;
      const result = await run(services, {
        projectId: flags.project,
        submissionId: flags.submission,
        digest: flags.digest,
      });
      writeOut(`version: ${result.version}\nidempotent: ${Boolean(result.idempotent)}\npublished: true\ncodesChanged: false\n`);
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
    } else if (command === "import-drive") {
      const staged = await importDriveSnapshot(flags.dir, flags.out);
      try {
        assertPublishable(staged.inspected);
      } catch (err) {
        if (!(err instanceof SchemaError)) throw err;
        writeOut(reportStaged(staged, null));
        return 1;
      }
      const result = await sealSnapshot(services, staged.inspected);
      writeOut(reportStaged(staged, result));
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
