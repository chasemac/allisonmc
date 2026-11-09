import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { widgetProblems } from "../lib/content-policy.js";
import { handle } from "../lib/router.js";
import { createMemoryServices } from "../lib/runtime.js";
import { seedDemo } from "../lib/demo-fixture.js";

const env = { RATE_LIMIT_MAX: "8", RATE_LIMIT_WINDOW_MS: "600000" };
const NAMESPACE = "http://www.collada.org/2005/11/COLLADASchema";

function widget(extra = "") {
  return `<!doctype html><html><head><style>body{color:#111}</style></head><body><p>Offline</p><script>
const template = '<COLLADA xmlns="${NAMESPACE}"></COLLADA>';
document.body.dataset.ready = template.slice(0, 8);
${extra}
</script></body></html>`;
}

test("multi-segment api paths stay on the single function", async () => {
  assert.equal(existsSync("api/[...path].js"), false);
  assert.equal(existsSync("api/handler.js"), true);
  const config = JSON.parse(readFileSync("vercel.json", "utf8"));
  assert.deepEqual(config.rewrites[0], { source: "/api/(.*)", destination: "/api/handler" });
  const source = readFileSync("api/handler.js", "utf8");
  assert.match(source, /return handle\(request\)/);
  for (const pathname of [
    "/api/projects/demo-northglass/media/plan",
    "/api/projects/demo-northglass/widgets/sketch",
  ]) {
    assert.equal(new RegExp(`^${config.rewrites[0].source}$`).test(pathname), true);
    const segments = pathname.slice("/api/".length).split("/");
    assert.ok(segments.length > 1);
  }
  const services = createMemoryServices({ CODE_PEPPER: "test-pepper-not-secret-32chars!!" });
  await seedDemo(services);
  for (const pathname of [
    "/api/projects/demo-northglass/media/plan",
    "/api/projects/demo-northglass/widgets/sketch",
  ]) {
    const response = await handle(new Request(`http://127.0.0.1${pathname}`), { services, env });
    assert.equal(response.status, 401);
    assert.match(await response.text(), /session has ended/);
  }
});

test("the collada namespace identifier is not an external widget url", () => {
  assert.deepEqual(widgetProblems(Buffer.from(widget())), []);
  assert.match(widgetProblems(Buffer.from(widget().replace(NAMESPACE, "https://example.com/collect")))[0], /external url/);
  assert.match(
    widgetProblems(Buffer.from(widget().replace("</head>", `<script src="${NAMESPACE}"></script></head>`)))[0],
    /external script/,
  );
  assert.match(
    widgetProblems(Buffer.from(widget().replace(NAMESPACE, `${NAMESPACE}/extra`)))[0],
    /external url/,
  );
});
