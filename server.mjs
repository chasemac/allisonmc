import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handle } from "./lib/router.js";
import { createMemoryServices } from "./lib/runtime.js";
import { seedDemo } from "./lib/demo-fixture.js";
import { readPublicFile } from "./lib/static-public.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const pepper = process.env.CODE_PEPPER || "local-demo-pepper-not-for-production";
const services = createMemoryServices({ CODE_PEPPER: pepper });
if (process.env.DEMO_FIXTURE === "1") await seedDemo(services);

const port = Number(process.env.PORT || 4173);
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname.startsWith("/api/")) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (["host", "connection", "content-length", "transfer-encoding"].includes(key)) continue;
        if (Array.isArray(value)) value.forEach((item) => headers.append(key, item));
        else if (value) headers.set(key, value);
      }
      const request = new Request(url.toString(), {
        method: req.method,
        headers,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
      });
      const response = await handle(request, { services, env: process.env });
      const outgoing = {};
      for (const [key, value] of response.headers) {
        if (key !== "set-cookie") outgoing[key] = value;
      }
      const cookies = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
      if (cookies.length) outgoing["set-cookie"] = cookies;
      res.writeHead(response.status, outgoing);
      res.end(Buffer.from(await response.arrayBuffer()));
      return;
    }
    const file = await readPublicFile(root, url.pathname);
    if (!file) {
      const missing = await readPublicFile(root, "/404.html");
      res.writeHead(404, { "content-type": "text/html; charset=utf-8", "x-content-type-options": "nosniff" });
      res.end(missing ? missing.bytes : "Not found");
      return;
    }
    res.writeHead(200, {
      "content-type": file.contentType,
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "content-security-policy":
        "default-src 'self'; img-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
    });
    res.end(file.bytes);
  } catch {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end("Unavailable");
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`http://127.0.0.1:${port}`);
});
