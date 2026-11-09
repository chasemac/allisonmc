import { readFile } from "node:fs/promises";
import path from "node:path";

const FILES = new Map([
  ["/", "index.html"],
  ["/index.html", "index.html"],
  ["/musings", "musings.html"],
  ["/musings/", "musings.html"],
  ["/musings.html", "musings.html"],
  ["/view", "view.html"],
  ["/view/", "view.html"],
  ["/view.html", "view.html"],
  ["/404.html", "404.html"],
  ["/legacy-home.html", "legacy-home.html"],
  ...[
    "work.html",
    "work-mcelroy-kitchen.html",
    "work-mcelroy-bathroom.html",
    "services.html",
    "about.html",
    "stories.html",
    "story-our-home-in-phases.html",
    "inquire.html",
  ].map((page) => [`/${page}`, page]),
  ["/css/styles.css", "css/styles.css"],
  ["/css/site.css", "css/site.css"],
  ["/js/view.js", "js/view.js"],
  ["/js/inquire.js", "js/inquire.js"],
  ["/assets/favicon.ico", "assets/favicon.ico"],
  ["/CNAME", "CNAME"],
]);

const IMAGE = /^\/assets\/img\/[A-Za-z0-9._-]+$/;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
};

export function publicRelativePath(pathname) {
  if (typeof pathname !== "string" || pathname.includes("\0") || pathname.includes("\\")) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded !== pathname || decoded.includes("..")) return null;
  if (FILES.has(decoded)) return FILES.get(decoded);
  if (IMAGE.test(decoded)) return decoded.slice(1);
  return null;
}

export async function readPublicFile(root, pathname) {
  const relative = publicRelativePath(pathname);
  if (!relative) return null;
  const full = path.resolve(root, relative);
  const rootResolved = path.resolve(root);
  if (full !== rootResolved && !full.startsWith(rootResolved + path.sep)) return null;
  try {
    const bytes = await readFile(full);
    const extension = path.extname(full).toLowerCase();
    return { bytes, contentType: TYPES[extension] || "application/octet-stream" };
  } catch {
    return null;
  }
}
