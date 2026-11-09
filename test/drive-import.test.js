import assert from "node:assert/strict";
import crypto from "node:crypto";
import { access, chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rmdir, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { main } from "../lib/cli.js";
import { importDriveSnapshot } from "../lib/drive-import.js";
import { canonicalDigest, inspectSnapshot } from "../lib/ingest.js";
import { SchemaError } from "../lib/errors.js";

const PEPPER = "test-pepper-not-secret-32chars!!";
const MARKER = "SYNTHETIC_CODE_MARKER";
const SENTINEL = "SENTINEL_OUTSIDE_FILE";
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082",
  "hex",
);

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function standardDocument(projectId, submissionId, assets) {
  return {
    projectId,
    submissionId,
    title: "Synthetic project",
    client: "Synthetic client",
    location: "Synthetic place",
    preparedBy: "Synthetic author",
    date: "2026-01-01",
    notesForReviewers: "Synthetic reviewer note.",
    content: {
      summary: "Synthetic summary for a private viewing test.",
      sections: [{ id: "overview", heading: "Overview", body: "Synthetic section body." }],
    },
    assets: assets ?? [{ path: "assets/photo.png", role: "gallery", note: "photo" }],
  };
}

async function exists(file) {
  try {
    await lstat(file);
    return true;
  } catch (err) {
    if (err.code === "ENOENT") return false;
    throw err;
  }
}

async function fingerprint(dir) {
  const lines = [];
  async function walk(relative) {
    const full = relative ? path.join(dir, relative) : dir;
    const stat = await lstat(full);
    if (stat.isSymbolicLink()) {
      lines.push(`link:${relative}:${await readlink(full)}`);
      return;
    }
    if (stat.isDirectory()) {
      for (const name of (await readdir(full)).sort()) await walk(relative ? `${relative}/${name}` : name);
      return;
    }
    lines.push(`${relative}:${stat.size}:${sha256(await readFile(full))}:${stat.mtimeNs}`);
  }
  await walk("");
  return lines.sort().join("\n");
}

async function writeSnapshot(dir, options = {}) {
  const projectId = options.projectId ?? "proj_example_001";
  const submissionId = options.submissionId ?? "sub_example_001";
  const document = options.document ?? standardDocument(projectId, submissionId, options.assets);
  const entries = options.entries ?? [
    ["content.json", Buffer.from(`${JSON.stringify(document)}\n`)],
    ["assets/photo.png", PNG],
  ];
  for (const [file, bytes] of entries) {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), bytes);
  }
  const listed = entries.map(([file, bytes]) => ({ path: file, size: bytes.length, sha256: sha256(bytes) }));
  const actualDigest = canonicalDigest(projectId, submissionId, listed);
  if (options.ready !== false) {
    const ready = {
      projectId,
      submissionId,
      files: options.listed ?? listed,
      ...(options.omitDigest ? {} : { digest: options.digest === undefined ? actualDigest : options.digest }),
    };
    await writeFile(path.join(dir, "READY.json"), `${JSON.stringify(ready)}\n`);
  }
  return { projectId, submissionId, actualDigest, listed };
}

async function pair() {
  const parent = await mkdtemp(path.join(tmpdir(), "amc-drive-"));
  const source = path.join(parent, "source");
  const out = path.join(parent, "stage");
  await mkdir(source);
  return { parent, source, out };
}

function capture() {
  const out = [];
  const err = [];
  return {
    out,
    err,
    io: {
      stdout: { write(text) { out.push(String(text)); } },
      stderr: { write(text) { err.push(String(text)); } },
    },
    text() { return out.join(""); },
    error() { return err.join(""); },
  };
}

function cliEnv(parent, extra = {}) {
  return {
    AMC_ENV_FILE: path.join(parent, "no-env-file"),
    CODE_PEPPER: PEPPER,
    RATE_LIMIT_MAX: "8",
    RATE_LIMIT_WINDOW_MS: "600000",
    AMC_TARGET: "",
    VERCEL_ENV: "",
    ...extra,
  };
}

async function expectRefusal(prepare, message) {
  const { parent, source, out } = await pair();
  await writeSnapshot(source);
  await prepare({ parent, source, out });
  const before = await fingerprint(source);
  await assert.rejects(importDriveSnapshot(source, out), message);
  assert.equal(await exists(out), false);
  assert.equal(await fingerprint(source), before);
  return { parent, source, out };
}

test("import-drive stages a local snapshot, can seal in memory, and does not publish", async () => {
  const { parent, source, out } = await pair();
  const box = await writeSnapshot(source);
  const before = await fingerprint(source);
  const state = path.join(parent, "dev.json");
  const env = cliEnv(parent);
  const registered = capture();
  assert.equal(await main([
    "register-project", "--store", "memory", "--state", state,
    "--project", box.projectId, "--title", "Synthetic project",
  ], env, registered.io), 0);

  const sealed = capture();
  assert.equal(await main([
    "import-drive", "--dir", source, "--out", out, "--seal", "--store", "memory", "--state", state,
  ], env, sealed.io), 0);
  const text = sealed.text();
  assert.match(text, new RegExp(`snapshotDigest: ${box.actualDigest}`));
  assert.match(text, /manifestDigestMatches: true/);
  assert.match(text, /files: 2/);
  assert.match(text, /publishable: yes/);
  assert.match(text, /published: false/);
  assert.match(text, /sealed: true/);
  assert.match(text, /idempotent: false/);
  assert.doesNotMatch(text, /published: true/);
  assert.doesNotMatch(text, /codesChanged/);
  assert.equal(sealed.error(), "");
  assert.equal(await fingerprint(source), before);
  const stagedPath = text.match(/^staged: (.+)$/m)[1];
  assert.equal(stagedPath, await realpath(out));
  const stagedStat = await lstat(stagedPath);
  assert.equal(stagedStat.isSymbolicLink(), false);
  assert.equal(stagedStat.isDirectory(), true);
  assert.equal(Buffer.compare(await readFile(path.join(stagedPath, "assets/photo.png")), PNG), 0);
  assert.equal(Buffer.compare(await readFile(path.join(stagedPath, "READY.json")), await readFile(path.join(source, "READY.json"))), 0);
  assert.equal((await lstat(path.join(stagedPath, "content.json"))).mode & 0o077, 0);
  assert.equal((await lstat(path.join(stagedPath, "assets/photo.png"))).isSymbolicLink(), false);
  const inspected = await inspectSnapshot(stagedPath);
  assert.equal(inspected.digest, box.actualDigest);

  const saved = JSON.parse(await readFile(state, "utf8"));
  assert.equal(saved.snapshots.length, 1);
  assert.deepEqual(saved.approvals, []);
  assert.deepEqual(saved.publications, []);

  const again = capture();
  const out2 = path.join(parent, "stage-2");
  assert.equal(await main([
    "import-drive", "--dir", source, "--out", out2, "--seal", "--store", "memory", "--state", state,
  ], env, again.io), 0);
  assert.match(again.text(), /idempotent: true/);
  assert.match(again.text(), /published: false/);
  assert.match(again.text(), /sealed: true/);
  const savedAgain = JSON.parse(await readFile(state, "utf8"));
  assert.deepEqual(savedAgain.approvals, []);
  assert.deepEqual(savedAgain.publications, []);

  const denied = capture();
  assert.equal(await main([
    "publish", "--store", "memory", "--state", state,
    "--project", box.projectId, "--submission", box.submissionId, "--digest", box.actualDigest,
  ], env, denied.io), 1);
  assert.match(denied.error(), /approval required/);
  const afterDeny = JSON.parse(await readFile(state, "utf8"));
  assert.deepEqual(afterDeny.publications, []);
});

test("import-drive without --seal prints the receipt and does not open a store", async () => {
  const { parent, source, out } = await pair();
  const box = await writeSnapshot(source, { omitDigest: true });
  const io = capture();
  assert.equal(await main([
    "import-drive", "--dir", source, "--out", out,
  ], { AMC_ENV_FILE: path.join(parent, "no-env-file") }, io.io), 0);
  assert.match(io.text(), new RegExp(`snapshotDigest: ${box.actualDigest}`));
  assert.match(io.text(), /manifestDigestMatches: absent/);
  assert.match(io.text(), /publishable: yes/);
  assert.match(io.text(), /published: false/);
  assert.match(io.text(), /sealed: false/);
  assert.doesNotMatch(io.text(), /idempotent:/);
  assert.equal(io.error(), "");
  assert.equal(await exists(path.join(parent, "dev.json")), false);
});

test("a snapshot that fails the content checks is not sealed", async () => {
  const { parent, source, out } = await pair();
  const html = Buffer.from("<!doctype html><html><head><script src=\"https://cdn.example/app.js\"></script><style>body{color:#111}</style></head><body><p>Synthetic</p></body></html>");
  const assets = [
    { path: "assets/photo.png", role: "gallery", note: "photo" },
    { path: "assets/viewer.html", role: "interactive-3d-viewer", note: "viewer" },
  ];
  const document = standardDocument("proj_example_001", "sub_example_001", assets);
  await writeSnapshot(source, {
    document,
    entries: [
      ["content.json", Buffer.from(`${JSON.stringify(document)}\n`)],
      ["assets/photo.png", PNG],
      ["assets/viewer.html", html],
    ],
  });
  const state = path.join(parent, "dev.json");
  const env = cliEnv(parent);
  assert.equal(await main([
    "register-project", "--store", "memory", "--state", state,
    "--project", "proj_example_001", "--title", "Synthetic project",
  ], env, capture().io), 0);
  const open = capture();
  const plain = path.join(parent, "plain");
  assert.equal(await main(["import-drive", "--dir", source, "--out", plain], env, open.io), 0);
  assert.match(open.text(), /publishable: no/);
  assert.match(open.text(), /sealed: false/);
  assert.equal(await exists(plain), true);
  const sealed = capture();
  assert.equal(await main([
    "import-drive", "--dir", source, "--out", out, "--seal", "--store", "memory", "--state", state,
  ], env, sealed.io), 1);
  assert.match(sealed.text(), /publishable: no/);
  assert.match(sealed.text(), /sealed: false/);
  assert.doesNotMatch(sealed.text(), /sealed: true/);
  const saved = JSON.parse(await readFile(state, "utf8"));
  assert.deepEqual(saved.snapshots, []);
  assert.deepEqual(saved.approvals, []);
  assert.deepEqual(saved.publications, []);
});

test("seal without a registered project leaves the stage unpublished", async () => {
  const { parent, source, out } = await pair();
  await writeSnapshot(source);
  const state = path.join(parent, "dev.json");
  const io = capture();
  assert.equal(await main([
    "import-drive", "--dir", source, "--out", out, "--seal", "--store", "memory", "--state", state,
  ], cliEnv(parent), io.io), 1);
  assert.match(io.error(), /Unknown project/);
  assert.equal(await exists(out), true);
  assert.equal(await exists(state), false);
});

test("help describes import-drive as a manual stage", async () => {
  const io = capture();
  assert.equal(await main(["help"], {}, io.io), 0);
  assert.match(io.text(), /import-drive --dir/);
  assert.match(io.text(), /does not approve or publish/);
  assert.match(io.text(), /still syncing, try again/);
  assert.match(io.text(), /project-access.json/);
  assert.match(io.text(), /no watcher/);
});

test("missing arguments and publish flags are refused before a copy", async () => {
  const { parent, source, out } = await pair();
  await writeSnapshot(source);
  const env = cliEnv(parent);
  const before = await fingerprint(source);
  const missingDir = capture();
  assert.equal(await main(["import-drive", "--out", out], env, missingDir.io), 1);
  assert.match(missingDir.error(), /Missing snapshot directory/);
  const missingOut = capture();
  assert.equal(await main(["import-drive", "--dir", source], env, missingOut.io), 1);
  assert.match(missingOut.error(), /Missing output directory/);
  const publishFlag = capture();
  assert.equal(await main([
    "import-drive", "--dir", source, "--out", out, "--operation", "publish",
  ], env, publishFlag.io), 1);
  assert.match(publishFlag.error(), /Unknown argument/);
  const watch = capture();
  assert.equal(await main([
    "import-drive", "--dir", source, "--out", out, "--watch", "1",
  ], env, watch.io), 1);
  assert.match(watch.error(), /Unknown argument/);
  const storeOnly = capture();
  assert.equal(await main([
    "import-drive", "--dir", source, "--out", out, "--store", "remote",
  ], env, storeOnly.io), 1);
  assert.match(storeOnly.error(), /Unknown argument/);
  const valued = capture();
  assert.equal(await main([
    "import-drive", "--dir", source, "--out", out, "--seal", "true",
  ], env, valued.io), 1);
  assert.match(valued.error(), /Unexpected value/);
  assert.equal(await exists(out), false);
  assert.equal(await fingerprint(source), before);
});

test("remote seal is refused before staging when the target is not production", async () => {
  const { parent, source, out } = await pair();
  await writeSnapshot(source);
  const before = await fingerprint(source);
  const io = capture();
  assert.equal(await main([
    "import-drive", "--dir", source, "--out", out, "--seal",
  ], cliEnv(parent), io.io), 1);
  assert.match(io.error(), /AMC_TARGET=production/);
  assert.equal(await exists(out), false);
  assert.equal(await fingerprint(source), before);
});

test("preview cannot seal through import-drive", async () => {
  const { parent, source, out } = await pair();
  await writeSnapshot(source);
  const io = capture();
  assert.equal(await main([
    "import-drive", "--dir", source, "--out", out, "--seal", "--store", "remote",
  ], cliEnv(parent, { AMC_TARGET: "production", VERCEL_ENV: "preview" }), io.io), 1);
  assert.match(io.error(), /Preview cannot use production/);
  assert.equal(await exists(out), false);
});

test("READY.json must already be present", async () => {
  const { source, out } = await pair();
  await writeSnapshot(source, { ready: false });
  await assert.rejects(importDriveSnapshot(source, out), { message: "READY.json is missing" });
  assert.equal(await exists(out), false);
});

test("a folder that changes between scans is still syncing", async () => {
  const { source, out } = await pair();
  await writeSnapshot(source);
  await assert.rejects(importDriveSnapshot(source, out, {
    betweenScans: async () => {
      const file = path.join(source, "assets/photo.png");
      await writeFile(file, Buffer.concat([await readFile(file), Buffer.from([0])]));
    },
  }), { message: "still syncing, try again" });
  assert.equal(await exists(out), false);
});

test("a file that appears between scans is still syncing", async () => {
  const { source, out } = await pair();
  await writeSnapshot(source);
  await assert.rejects(importDriveSnapshot(source, out, {
    betweenScans: async () => {
      await writeFile(path.join(source, "assets/other.png"), PNG);
    },
  }), { message: "still syncing, try again" });
  assert.equal(await exists(out), false);
});

test("READY.json appearing between scans is still syncing", async () => {
  const { source, out } = await pair();
  const box = await writeSnapshot(source, { ready: false });
  await assert.rejects(importDriveSnapshot(source, out, {
    betweenScans: async () => {
      await writeSnapshot(source, { digest: box.actualDigest });
    },
  }), { message: "still syncing, try again" });
  assert.equal(await exists(out), false);
});

test("a file that changes after the scans is still syncing and the partial stage is removed", async () => {
  const { source, out } = await pair();
  await writeSnapshot(source);
  await assert.rejects(importDriveSnapshot(source, out, {
    beforeCopy: async () => {
      await writeFile(path.join(source, "content.json"), Buffer.from("{\"changed\":true}\n"));
    },
  }), { message: "still syncing, try again" });
  assert.equal(await exists(out), false);
});

test("a listed size that does not match is refused", async () => {
  await expectRefusal(async ({ source }) => {
    const ready = JSON.parse(await readFile(path.join(source, "READY.json"), "utf8"));
    ready.files.find((file) => file.path === "assets/photo.png").size += 1;
    await writeFile(path.join(source, "READY.json"), JSON.stringify(ready));
  }, { message: "manifest size" });
});

test("a listed sha256 that does not match is refused", async () => {
  await expectRefusal(async ({ source }) => {
    const ready = JSON.parse(await readFile(path.join(source, "READY.json"), "utf8"));
    ready.files.find((file) => file.path === "content.json").sha256 = sha256(Buffer.from("different"));
    await writeFile(path.join(source, "READY.json"), JSON.stringify(ready));
  }, { message: "manifest hash" });
});

test("a digest that does not match is refused", async () => {
  await expectRefusal(async ({ source }) => {
    const ready = JSON.parse(await readFile(path.join(source, "READY.json"), "utf8"));
    ready.digest = "ab".repeat(32);
    await writeFile(path.join(source, "READY.json"), JSON.stringify(ready));
  }, { message: "manifest digest does not match" });
});

test("a digest that is not a sha256 is refused", async () => {
  await expectRefusal(async ({ source }) => {
    const ready = JSON.parse(await readFile(path.join(source, "READY.json"), "utf8"));
    ready.digest = "not-a-digest";
    await writeFile(path.join(source, "READY.json"), JSON.stringify(ready));
  }, { message: "manifest digest" });
});

test("a missing listed file is refused", async () => {
  await expectRefusal(async ({ source }) => {
    await unlink(path.join(source, "assets/photo.png"));
  }, { message: "manifest does not match files" });
});

test("an extra file is refused and the stage is removed", async () => {
  await expectRefusal(async ({ source }) => {
    await writeFile(path.join(source, "notes.txt"), "synthetic note");
  }, { message: "manifest does not match files" });
});

test("a swapped file is reported as an extra file", async () => {
  await expectRefusal(async ({ source }) => {
    await unlink(path.join(source, "assets/photo.png"));
    await writeFile(path.join(source, "assets/other.png"), PNG);
  }, { message: "extra file" });
});

test("invalid READY.json does not echo its contents", async () => {
  const { source, out } = await pair();
  await writeSnapshot(source);
  await writeFile(path.join(source, "READY.json"), `${MARKER} {"digest":\n`);
  await assert.rejects(importDriveSnapshot(source, out), (err) => {
    assert.equal(err instanceof SchemaError, true);
    assert.equal(err.message, "READY.json is not valid JSON");
    assert.equal(err.message.includes(MARKER), false);
    return true;
  });
  assert.equal(await exists(out), false);
});

test("an unexpected content.json field is still rejected", async () => {
  const { source, out } = await pair();
  const document = standardDocument("proj_example_001", "sub_example_001");
  document.extra = true;
  await writeSnapshot(source, { document });
  await assert.rejects(importDriveSnapshot(source, out), { message: "unexpected submission field" });
  assert.equal(await exists(out), false);
});

test("a symlink inside the snapshot is refused without reading the target", async () => {
  const { parent, source, out } = await pair();
  await writeSnapshot(source);
  const secret = path.join(parent, "secret.txt");
  await writeFile(secret, SENTINEL);
  await symlink(secret, path.join(source, "assets", "linked.png"));
  await assert.rejects(importDriveSnapshot(source, out), (err) => {
    assert.match(err.message, /^symlink refused/);
    assert.equal(err.message.includes(SENTINEL), false);
    return true;
  });
  assert.equal(await exists(out), false);
  assert.equal(await readFile(secret, "utf8"), SENTINEL);
});

test("a symlink directory is refused without entering it", async () => {
  const { parent, source, out } = await pair();
  await writeSnapshot(source);
  const outside = path.join(parent, "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "secret.txt"), SENTINEL);
  await unlink(path.join(source, "assets/photo.png"));
  await rmdir(path.join(source, "assets"));
  await symlink(outside, path.join(source, "assets"));
  await assert.rejects(importDriveSnapshot(source, out), (err) => {
    assert.match(err.message, /^symlink refused/);
    assert.equal(err.message.includes(SENTINEL), false);
    return true;
  });
  assert.equal(await exists(out), false);
  assert.equal(await readFile(path.join(outside, "secret.txt"), "utf8"), SENTINEL);
});

test("the source path itself cannot be a symlink", async () => {
  const { parent, source, out } = await pair();
  await writeSnapshot(source);
  const link = path.join(parent, "linked-source");
  await symlink(source, link);
  await assert.rejects(importDriveSnapshot(link, out), (err) => {
    assert.match(err.message, /^symlink refused/);
    return true;
  });
  assert.equal(await exists(out), false);
});

test("the output path cannot be a symlink", async () => {
  const { parent, source } = await pair();
  await writeSnapshot(source);
  const realOut = path.join(parent, "real-out");
  await mkdir(realOut);
  const link = path.join(parent, "stage");
  await symlink(realOut, link);
  await assert.rejects(importDriveSnapshot(source, link), (err) => {
    assert.match(err.message, /^symlink refused/);
    return true;
  });
  assert.deepEqual(await readdir(realOut), []);
});

test("the output parent cannot be a symlink", async () => {
  const { parent, source } = await pair();
  await writeSnapshot(source);
  const realParent = path.join(parent, "real-parent");
  await mkdir(realParent);
  const linkParent = path.join(parent, "link-parent");
  await symlink(realParent, linkParent);
  await assert.rejects(importDriveSnapshot(source, path.join(linkParent, "stage")), (err) => {
    assert.match(err.message, /^symlink refused/);
    return true;
  });
  assert.equal(await exists(path.join(realParent, "stage")), false);
});

test("an existing output directory is left untouched", async () => {
  const { source, out } = await pair();
  await writeSnapshot(source);
  await mkdir(out);
  await writeFile(path.join(out, "keep.txt"), "keep");
  await assert.rejects(importDriveSnapshot(source, out), { message: "output directory" });
  assert.equal(await readFile(path.join(out, "keep.txt"), "utf8"), "keep");
});

test("the stage cannot be inside the source or the source itself", async () => {
  const { source } = await pair();
  await writeSnapshot(source);
  const before = await fingerprint(source);
  await assert.rejects(importDriveSnapshot(source, path.join(source, "stage")), { message: "output directory" });
  await assert.rejects(importDriveSnapshot(source, source), { message: "output directory" });
  assert.equal(await exists(path.join(source, "stage")), false);
  assert.equal(await fingerprint(source), before);
});

test("path traversal in READY.json is refused", async () => {
  const { parent, source, out } = await pair();
  await writeSnapshot(source);
  const secret = path.join(parent, "secret.txt");
  await writeFile(secret, SENTINEL);
  for (const badPath of ["../secret.txt", "/etc/passwd", "assets/../../secret.txt"]) {
    const ready = JSON.parse(await readFile(path.join(source, "READY.json"), "utf8"));
    ready.files.push({ path: badPath, size: 4, sha256: "ab".repeat(32) });
    await writeFile(path.join(source, "READY.json"), JSON.stringify(ready));
    await assert.rejects(importDriveSnapshot(source, out), (err) => {
      assert.equal(err.message, "path traversal refused");
      assert.equal(err.message.includes(SENTINEL), false);
      return true;
    });
    assert.equal(await readFile(secret, "utf8"), SENTINEL);
  }
  assert.equal(await exists(out), false);
});

test("project-access.json is refused unread", async () => {
  const { parent, source, out } = await pair();
  await writeSnapshot(source);
  const accessFile = path.join(source, "assets", "Project-Access.json");
  await writeFile(accessFile, `{"note":"${MARKER}","codes":[{"code":"${MARKER}"}]}\n`, { mode: 0o000 });
  try {
    const io = capture();
    assert.equal(await main(["import-drive", "--dir", source, "--out", out], cliEnv(parent), io.io), 1);
    assert.match(io.error(), /codes belong in the separate access file/);
    assert.equal(`${io.text()}${io.error()}`.includes(MARKER), false);
    assert.equal(await exists(out), false);
    await assert.rejects(access(accessFile, 4), /EACCES/);
  } finally {
    await chmod(accessFile, 0o644);
  }
});

test("an AppleDouble file is refused with its path and a dot_clean hint", async () => {
  const { source, out } = await pair();
  await writeSnapshot(source);
  const relative = "assets/._photo.png";
  const full = path.join(source, relative);
  await writeFile(full, MARKER);
  await assert.rejects(importDriveSnapshot(source, out), (err) => {
    assert.equal(
      err.message,
      `refused AppleDouble file: ${relative}. Remove it with dot_clean on the snapshot folder, then import again.`,
    );
    assert.equal(err.message.includes(MARKER), false);
    return true;
  });
  assert.equal(await exists(out), false);
});

test("system junk and Google shortcut stubs are refused", async () => {
  const cases = [
    [".DS_Store", "refused .DS_Store"],
    ["Icon\r", "refused macOS Icon file"],
    ["assets/desktop.ini", "refused desktop.ini"],
    ["assets/~$photo.png", "refused Office lock file"],
    ["Notes.GDOC", "refused Google Docs shortcut"],
    ["assets/book.gsheet", "refused Google Docs shortcut"],
    ["assets/deck.gslides", "refused Google Docs shortcut"],
    ["assets/form.gform", "refused Google Docs shortcut"],
    ["assets/drawing.gdraw", "refused Google Docs shortcut"],
    [".hidden", "hidden file refused"],
  ];
  for (const [name, message] of cases) {
    const { source, out } = await pair();
    await writeSnapshot(source);
    const full = path.join(source, name);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, MARKER);
    await assert.rejects(importDriveSnapshot(source, out), (err) => {
      assert.equal(err.message.startsWith(message), true, err.message);
      assert.equal(err.message.includes(MARKER), false);
      assert.equal(err.message.includes("\r"), false);
      return true;
    });
    assert.equal(await exists(out), false);
  }
});

test("a hidden directory is refused before its contents are read", async () => {
  const { source, out } = await pair();
  await writeSnapshot(source);
  await mkdir(path.join(source, ".git"));
  const config = path.join(source, ".git", "config");
  await writeFile(config, MARKER, { mode: 0o000 });
  try {
    await assert.rejects(importDriveSnapshot(source, out), (err) => {
      assert.match(err.message, /^hidden file refused/);
      assert.equal(err.message.includes(MARKER), false);
      return true;
    });
    assert.equal(await exists(out), false);
    await assert.rejects(access(config, 4), /EACCES/);
  } finally {
    await chmod(config, 0o644);
  }
});
