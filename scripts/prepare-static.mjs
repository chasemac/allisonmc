import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { versionHtml } from "./asset-version.mjs";
import { refreshPreloads } from "./lato-preloads.mjs";
import { PAGES } from "./pages.mjs";

const root = process.cwd();
const dist = path.join(root, "dist");
const pages = PAGES;
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
for (const item of [...pages, "css", "js", "assets", "CNAME"]) {
  await cp(path.join(root, item), path.join(dist, item), { recursive: true });
}
await versionHtml(dist, pages);
if (process.env.AMC_FONT_PRELOADS !== "skip") {
  const fonts = await refreshPreloads(dist, pages);
  console.log(fonts.refreshed ? `Lato preloads refreshed: ${fonts.urls.join(" ")}` : `Lato preloads kept as committed (${fonts.reason}).`);
}
