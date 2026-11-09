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
