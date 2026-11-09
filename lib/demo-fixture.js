import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lookupHash, mediaPath } from "./codes.js";
import { validateCollada, validateWidgetHtml } from "./content-policy.js";
import { detectMedia } from "./media-types.js";
import { validatePresentation } from "./schema.js";

// NON-SECRET TEST FIXTURE.
// Published on purpose for local tests and an optional preview seed.
// This is not a client credential. Never set DEMO_FIXTURE on production.
export const TEST_FIXTURE_CODE = "demo-fixture-code-not-a-secret";
export const TEST_PROJECT_ID = "demo-northglass";
export const TEST_CODE_ID = "demo-fixture-code-id";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/demo");
const files = [
  ["plan", "plan.png"],
  ["section", "section.png"],
  ["detail", "detail.png"],
  ["notes", "notes.pdf"],
];
const special = [
  ["sketch", "sketch.html", validateWidgetHtml],
  ["model", "model.dae", validateCollada],
];

export async function seedDemo(services, { expiresAt = Date.now() + 90 * 24 * 60 * 60 * 1000 } = {}) {
  const presentation = validatePresentation(JSON.parse(await readFile(path.join(root, "project.json"), "utf8")));
  await services.store.upsertProject(presentation);
  for (const [mediaId, filename, validate] of special) {
    const detected = validate(await readFile(path.join(root, filename)));
    const pathname = mediaPath(presentation.id, mediaId);
    await services.media.put(pathname, detected.bytes, detected.contentType);
    await services.store.putMedia({
      projectId: presentation.id,
      mediaId,
      pathname,
      contentType: detected.contentType,
      filename,
      byteLength: detected.bytes.length,
    });
  }
  for (const [mediaId, filename] of files) {
    const detected = detectMedia(await readFile(path.join(root, filename)));
    if (!detected) throw new Error("demo fixture media rejected");
    const pathname = mediaPath(presentation.id, mediaId);
    await services.media.put(pathname, detected.bytes, detected.contentType);
    await services.store.putMedia({
      projectId: presentation.id,
      mediaId,
      pathname,
      contentType: detected.contentType,
      filename,
      byteLength: detected.bytes.length,
    });
  }
  const hash = lookupHash(TEST_FIXTURE_CODE, services.pepper);
  const existing = await services.store.getCodeByHash(hash);
  if (!existing) {
    await services.store.insertCode({
      id: TEST_CODE_ID,
      lookupHash: hash,
      projectId: presentation.id,
      label: "non-secret demo fixture",
      expiresAt,
    });
  }
  return presentation;
}
