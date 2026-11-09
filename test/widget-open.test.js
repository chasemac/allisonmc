import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { mediaPath } from "../lib/codes.js";
import { WIDGET_CSP, widgetProblems } from "../lib/content-policy.js";
import { TEST_FIXTURE_CODE, seedDemo } from "../lib/demo-fixture.js";
import { handle } from "../lib/router.js";
import { createMemoryServices } from "../lib/runtime.js";

const PEPPER = "test-pepper-not-secret-32chars!!";
const env = { RATE_LIMIT_MAX: "8", RATE_LIMIT_WINDOW_MS: "600000" };
const ORIGINAL = Buffer.from(
  `<!doctype html><html><head><script src="https://www.gstatic.com/antigravity/web/dev/tailwindcss.min.js"></script><style>body{margin:0}</style></head><body><p>Studio</p><script>document.body.dataset.ready=1</script><p>http://www.collada.org/2005/11/COLLADASchema</p></body></html>`,
);

function cookieHeader(response) {
  const match = /amc_session=([^;]*)/.exec(response.headers.get("set-cookie") || "");
  return match && match[1] ? `amc_session=${match[1]}` : "";
}

test("the full-screen widget route serves the stored bytes behind the session", async () => {
  assert.deepEqual(widgetProblems(ORIGINAL), []);
  assert.match(widgetProblems(Buffer.from(String(ORIGINAL).replace("www.gstatic.com", "cdn.example")))[0], /external script src:/);
  const services = createMemoryServices({ CODE_PEPPER: PEPPER });
  await seedDemo(services);
  await services.media.put(mediaPath("demo-northglass", "sketch"), ORIGINAL, "text/html");
  await services.store.putMedia({
    projectId: "demo-northglass",
    mediaId: "sketch",
    pathname: mediaPath("demo-northglass", "sketch"),
    contentType: "text/html",
    filename: "sketch.html",
    byteLength: ORIGINAL.length,
  });
  const locked = await handle(new Request("http://127.0.0.1/api/projects/demo-northglass/widgets/sketch/open"), { services, env });
  assert.equal(locked.status, 401);
  const opened = await handle(new Request("http://127.0.0.1/api/access", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.77" },
    body: JSON.stringify({ code: TEST_FIXTURE_CODE }),
  }), { services, env });
  const cookie = cookieHeader(opened);
  const response = await handle(new Request("http://127.0.0.1/api/projects/demo-northglass/widgets/sketch/open", {
    headers: { cookie },
  }), { services, env });
  assert.equal(response.status, 200);
  assert.equal(Buffer.compare(Buffer.from(await response.arrayBuffer()), ORIGINAL), 0);
  assert.equal(response.headers.get("content-security-policy"), WIDGET_CSP);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(WIDGET_CSP.includes("https://www.gstatic.com"), true);
  assert.equal(WIDGET_CSP.includes("connect-src 'none'"), true);
  assert.equal(WIDGET_CSP.includes("allow-same-origin"), false);
  const other = await handle(new Request("http://127.0.0.1/api/projects/proj_example_002/widgets/sketch/open", {
    headers: { cookie },
  }), { services, env });
  assert.equal(other.status, 404);
  const page = readFileSync("js/view.js", "utf8");
  assert.match(page, /Open 3D Kitchen Studio/);
  assert.equal(page.includes("srcdoc"), false);
  assert.equal(page.includes("iframe"), false);
  assert.match(page, /\/widgets\/\$\{block\.mediaId\}\/open/);
});

function headerEntries(response) {
  return [...response.headers.entries()].sort((left, right) => left[0].localeCompare(right[0]));
}

test("widget open and media responses pin the headers they actually send", async () => {
  const services = createMemoryServices({ CODE_PEPPER: PEPPER });
  await seedDemo(services);
  const denied = await handle(new Request("http://127.0.0.1/api/projects/demo-northglass/widgets/sketch/open"), { services, env });
  assert.equal(denied.status, 401);
  assert.deepEqual(headerEntries(denied), [
    ["cache-control", "private, no-store"],
    ["content-security-policy", "default-src 'none'; sandbox"],
    ["content-type", "application/json; charset=utf-8"],
    ["referrer-policy", "no-referrer"],
    ["x-content-type-options", "nosniff"],
    ["x-robots-tag", "noindex"],
  ]);

  const opened = await handle(new Request("http://127.0.0.1/api/access", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.78" },
    body: JSON.stringify({ code: TEST_FIXTURE_CODE }),
  }), { services, env });
  const cookie = cookieHeader(opened);
  const response = await handle(new Request("http://127.0.0.1/api/projects/demo-northglass/widgets/sketch/open", {
    headers: { cookie },
  }), { services, env });
  assert.equal(response.status, 200);
  assert.equal(WIDGET_CSP.includes("frame-ancestors"), false);
  assert.equal(WIDGET_CSP.includes("allow-same-origin"), false);
  assert.deepEqual(headerEntries(response), [
    ["accept-ranges", "none"],
    ["cache-control", "private, no-store"],
    ["content-security-policy", WIDGET_CSP],
    ["content-type", "text/html; charset=utf-8"],
    ["referrer-policy", "no-referrer"],
    ["x-content-type-options", "nosniff"],
    ["x-robots-tag", "noindex"],
  ]);
  assert.equal(response.headers.get("x-frame-options"), null);
  assert.equal(response.headers.get("cross-origin-resource-policy"), null);

  const image = await handle(new Request("http://127.0.0.1/api/projects/demo-northglass/media/plan", { headers: { cookie } }), { services, env });
  assert.equal(image.status, 200);
  assert.deepEqual(headerEntries(image), [
    ["accept-ranges", "none"],
    ["cache-control", "private, no-store"],
    ["content-disposition", "inline"],
    ["content-security-policy", "default-src 'none'; sandbox"],
    ["content-type", "image/png"],
    ["cross-origin-resource-policy", "same-origin"],
    ["referrer-policy", "no-referrer"],
    ["x-content-type-options", "nosniff"],
    ["x-robots-tag", "noindex"],
  ]);
  const pdf = await handle(new Request("http://127.0.0.1/api/projects/demo-northglass/media/notes", { headers: { cookie } }), { services, env });
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get("content-type"), "application/pdf");
  assert.equal(pdf.headers.get("content-disposition"), 'attachment; filename="notes.pdf"');
  assert.equal(pdf.headers.get("x-frame-options"), null);
  assert.equal(pdf.headers.get("content-security-policy").includes("frame-ancestors"), false);
  const model = await handle(new Request("http://127.0.0.1/api/projects/demo-northglass/attachments/model", { headers: { cookie } }), { services, env });
  assert.equal(model.status, 200);
  assert.deepEqual(headerEntries(model), [
    ["accept-ranges", "none"],
    ["cache-control", "private, no-store"],
    ["content-disposition", 'attachment; filename="fictional-model.dae"'],
    ["content-security-policy", "default-src 'none'; sandbox"],
    ["content-type", "model/vnd.collada+xml"],
    ["cross-origin-resource-policy", "same-origin"],
    ["referrer-policy", "no-referrer"],
    ["x-content-type-options", "nosniff"],
    ["x-robots-tag", "noindex"],
  ]);

  const config = JSON.parse(readFileSync("vercel.json", "utf8"));
  const pages = config.headers.find((item) => item.source === "/((?!api/).*)");
  const api = config.headers.find((item) => item.source === "/api/(.*)");
  assert.equal(pages.headers.find((item) => item.key === "X-Frame-Options").value, "DENY");
  assert.match(pages.headers.find((item) => item.key === "Content-Security-Policy").value, /frame-ancestors 'none'/);
  assert.deepEqual(api.headers.map((item) => item.key), ["Cache-Control", "X-Robots-Tag", "Referrer-Policy", "X-Content-Type-Options", "Strict-Transport-Security"]);
  assert.equal(api.headers.some((item) => item.key === "X-Frame-Options" || item.key === "Content-Security-Policy"), false);

  const workflow = readFileSync("docs/publishing/WORKFLOW.md", "utf8");
  assert.equal(workflow.includes(WIDGET_CSP), true);
  assert.equal(workflow.includes("framed by this origin"), false);
  for (const file of ["AGENTS.md", "docs/runbook.md", "README.md"]) {
    assert.equal(readFileSync(file, "utf8").includes("framed by this origin"), false, file);
  }
});
