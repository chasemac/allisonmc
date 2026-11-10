// Every HTML page the build ships. The designer site (css/site.css) plus the
// private viewer (css/site.css + css/portal.css) and the hidden legacy pages (css/styles.css).
export const SITE_PAGES = [
  "index.html",
  "work.html",
  "work-mcelroy-kitchen.html",
  "services.html",
  "about.html",
  "stories.html",
  "story-our-home-in-phases.html",
  "inquire.html",
  "404.html",
];
export const LEGACY_PAGES = ["legacy-home.html", "musings.html"];
export const PAGES = [...SITE_PAGES, "view.html", ...LEGACY_PAGES];
