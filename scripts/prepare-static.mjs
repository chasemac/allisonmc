import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const dist = path.join(root, "dist");
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
for (const item of ["index.html", "musings.html", "view.html", "404.html", "css", "js", "assets", "CNAME"]) {
  await cp(path.join(root, item), path.join(dist, item), { recursive: true });
}
