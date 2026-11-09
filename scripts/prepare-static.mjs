import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { versionHtml } from "./asset-version.mjs";

const root = process.cwd();
const dist = path.join(root, "dist");
const pages = ["index.html", "musings.html", "view.html", "404.html"];
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
for (const item of [...pages, "css", "js", "assets", "CNAME"]) {
  await cp(path.join(root, item), path.join(dist, item), { recursive: true });
}
await versionHtml(dist, pages);
