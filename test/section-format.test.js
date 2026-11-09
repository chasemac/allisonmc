import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { mapSubmission } from "../lib/content-policy.js";
import { SchemaError } from "../lib/errors.js";
import { validatePresentation } from "../lib/schema.js";

const fixture = () => JSON.parse(readFileSync("fixtures/demo/project.json", "utf8"));

function submission(extra = {}, sectionExtra = {}) {
  return {
    projectId: "proj_example_001",
    submissionId: "sub_example_001",
    title: "Short title",
    client: "Synthetic client",
    location: "Synthetic place",
    preparedBy: "Synthetic author",
    date: "2026-01-01",
    notesForReviewers: "Synthetic reviewer note.",
    content: {
      summary: "Synthetic summary for a private viewing test.",
      sections: [{
        id: "overview",
        heading: "Overview",
        body: "Synthetic section body.",
        ...sectionExtra,
      }],
    },
    assets: [],
    ...extra,
  };
}

test("older projects without a subtitle or section summary still validate", () => {
  const legacy = fixture();
  delete legacy.subtitle;
  for (const section of legacy.sections) delete section.summary;
  const clean = validatePresentation(legacy);
  assert.equal(Object.hasOwn(clean, "subtitle"), false);
  assert.equal(clean.sections.every((section) => !Object.hasOwn(section, "summary")), true);
  assert.equal(clean.title, "Northglass Reading Room");
  const current = validatePresentation(fixture());
  assert.equal(current.subtitle, "Fictional demo for private viewing, not a client project");
  assert.equal(current.sections.find((section) => section.id === "option-a").summary, "Invented west and north walls, with the east side left open.");
});

test("subtitle and section summary are optional lines, and HTML blocks stay rejected", () => {
  const base = fixture();
  assert.throws(() => validatePresentation({ ...base, subtitle: "   " }), SchemaError);
  assert.throws(() => validatePresentation({
    ...base,
    sections: [{ id: "x", title: "X", summary: " ", blocks: [{ type: "text", text: "Still here." }] }],
  }), SchemaError);
  assert.throws(() => validatePresentation({
    ...base,
    sections: [{ id: "x", title: "X", blocks: [{ type: "html", html: "<script>alert(1)</script>" }] }],
  }), SchemaError);
  const kept = validatePresentation({
    ...base,
    subtitle: "Kitchen line\nunder the title",
    sections: [{
      id: "x",
      title: "X",
      summary: "One line\nonly",
      blocks: [{ type: "text", text: "<script>alert(1)</script> stays text." }],
    }],
  });
  assert.equal(kept.subtitle, "Kitchen line under the title");
  assert.equal(kept.sections[0].summary, "One line only");
  assert.equal(kept.sections[0].blocks[0].text, "<script>alert(1)</script> stays text.");
});

test("a submission can carry a subtitle and structured section text", () => {
  const body = "## West wall\n\n- West wall: a 36\" shelf.\n\nSecond paragraph stays.";
  const mapped = mapSubmission(submission(
    { subtitle: "Package name under the heading" },
    { summary: "West wall only.", body },
  ), new Map());
  assert.equal(mapped.presentation.subtitle, "Package name under the heading");
  const section = mapped.presentation.sections.find((item) => item.id === "overview");
  assert.equal(section.summary, "West wall only.");
  assert.equal(section.blocks[0].text, body);
  const plain = mapSubmission(submission(), new Map());
  assert.equal(Object.hasOwn(plain.presentation, "subtitle"), false);
  const overview = plain.presentation.sections.find((item) => item.id === "overview");
  assert.equal(overview.blocks[0].text, "Synthetic section body.");
  assert.equal(Object.hasOwn(overview, "summary"), false);
  assert.throws(() => mapSubmission(submission({ subtitle: " " }), new Map()), /invalid subtitle/);
  assert.throws(() => mapSubmission(submission({}, { lede: "no" }), new Map()), /unexpected section field/);
});
