// Every HTML page the build ships. The designer site (css/site.css) plus the
// pages that keep css/styles.css: the private viewer and the hidden legacy pages.
export const SITE_PAGES = [
  "index.html",
  "work.html",
  "work-mcelroy-kitchen.html",
  "work-mcelroy-bathroom.html",
  "services.html",
  "about.html",
  "stories.html",
  "story-our-home-in-phases.html",
  "inquire.html",
  "404.html",
];
export const LEGACY_PAGES = ["legacy-home.html", "musings.html"];
export const PAGES = [...SITE_PAGES, "view.html", ...LEGACY_PAGES];
