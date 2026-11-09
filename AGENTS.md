# Agent guide

This site is Allison McElroy's public biography plus a private, code-gated project viewer. Read [docs/publishing/WORKFLOW.md](docs/publishing/WORKFLOW.md) before any work on client content. Read [docs/runbook.md](docs/runbook.md) before changing access, storage, or the developer CLI.

There is no `.cursor` rules file or skill in this repo. This file is the agent entry point.

## How a change ships

Work on a branch and open a pull request against `main`. Do not merge it yourself. An independent review happens before merge. The Vercel project `allisonmc` on team `chasemacs-projects` auto-deploys production from `main`. After that deploy, check the live site. A content publish has its own checks in the workflow doc.

Do not run a production deploy from the agent. Do not edit Vercel environment variables, Neon plan or billing, DNS, mail, or the registrar from an agent turn.

## Hosting and DNS

The live site is that Vercel project. `allisonmc.com` and `www.allisonmc.com` are attached there. The domain cutover is DNS-only on Squarespace. Do not change Squarespace DNS records, nameservers, or the registrar. Mail stays on the existing iCloud MX and TXT records. Do not edit them.

`CNAME` in the repo is copied into `dist/` by the static build. Leave that file alone. It is not the DNS control panel. Do not disable GitHub Pages from an agent turn.

## Stack

Public pages are static HTML, CSS, and a small client script. The build is `node scripts/prepare-static.mjs`. Output is `dist/`. Do not add a framework or an admin site. Files under `/assets/` are cached for 30 days, so the build appends `?v=<content hash>` to every `assets/` reference in the built HTML (`scripts/asset-version.mjs`). Replace an image at the same path and its URL changes on the next deploy; reference new public assets from the four HTML pages, not from CSS or JS.

One Vercel Function, `api/handler.js`, serves the API. `vercel.json` rewrites `/api/(.*)` to `/api/handler`, so paths such as `/api/projects/:id/media/:mid` and `/api/projects/:id/widgets/:mediaId/open` are not dropped. `/view` rewrites to `/view.html`. `/musings` rewrites to `/musings.html`.

Neon Postgres is the Free plan only. Never upgrade it to a paid plan. It stores projects, HMAC share-code hashes, sessions, and the shared rate limit.

Project assets live in a private Vercel Blob store. The function reads them with `get(pathname, { access: "private" })` after the session check. The browser never receives a Blob URL. Do not make the store public.

The Vercel project uses Node.js 22. Framework preset is Other.

## Typography

Allison wants Lato and nothing else. The pages load Google Fonts Lato 300, 400, and 700, upright and italic:

`https://fonts.googleapis.com/css2?family=Lato:ital,wght@0,300;0,400;0,700;1,300;1,400;1,700&display=swap`

That link is on `index.html`, `musings.html`, `view.html`, and `404.html`. `css/styles.css` sets `--font` to Lato with a system sans-serif fallback (`-apple-system`, `Segoe UI`, Roboto, `Helvetica Neue`, Arial, `sans-serif`). `--serif` and `--sans` both point at `--font`. Headings, card titles, and bold labels are weight 700. Body copy is 400. The subtitle, a collapsed card's one-line summary, and the footer are 300.

Do not reintroduce Fraunces, Outfit, or any other family unless a person asks. The page CSP already allows `style-src` from `https://fonts.googleapis.com` and `font-src` from `https://fonts.gstatic.com`. Do not widen it for a new font host.

## Public pages

Keep the existing biography, musings, profile photo, Behance portfolio link, and LinkedIn link until a person supplies new copy. Do not invent projects, credentials, quotes, or personal facts. The fictional demo under `fixtures/demo/` is a labeled test project, not her work, and it must stay labeled that way.

## Private viewing, as built

Clients have no accounts. There is no admin UI and no comment thread. One shared code opens one project.

The viewer is `/view.html`, also served as `/view`. `js/view.js` does not read `?project=`. The code selects the project. A note such as `/view.html?project=<id>` does not switch projects. The access page is not a form, and the field has no name, so a browser with JavaScript disabled cannot put the code in a URL. `POST /api/access` sends `{ "code": "..." }`. A `code` query parameter is rejected with 400. The server stores only an HMAC of the normalized code. It reads the private Blob canary and checks its digest before it sets an HttpOnly SameSite=Strict session cookie (`amc_session`) for that one project. On HTTPS the cookie is also `Secure`. The session lasts at most 12 hours and never longer than the code. Every presentation, image, PDF, DAE, and widget request checks that session. A session for project A gets 404 for project B. A missing or ended session gets 401.

Responses use `Cache-Control: private, no-store`, `Referrer-Policy: no-referrer`, and `X-Robots-Tag: noindex`. Missing Postgres, Blob configuration, or rate-limit configuration fails closed with 503 and does not grant a session. Hosted preview fails closed the same way. The in-memory adapter is for local tests and is refused on Vercel. Those tests do not call a live database or Blob store.

The page does not show a Leave project button. `POST /api/logout` still revokes a session. Do not add the button back unless a person asks.

## Project page

Tabs are Overview, Sections, Drawings, and Model & files. Overview is always present. A tab with no sections is omitted. On a narrow screen the tab list scrolls sideways (`overflow-x: auto`). It does not wrap. The selected tab is cream `#f6f1e8` on cypress `#16332e`.

Grouping in `sectionTab`:

- `meta-details`, `meta-notes`, and `overview` go to Overview.
- `role-3d-preview`, id `3d-preview`, or title `3D preview` goes to Model & files, including when the block is a gallery. Do not put 3D preview snapshots on Drawings.
- Other `role-*` image roles (`hero`, `page-preview`, `plan-sheet`, `proposal-preview`, `punchlist-preview`, `reference-photo`, `gallery`) go to Drawings.
- A widget block or an attachment goes to Model & files.
- Remaining text longer than 180 characters goes to Sections. Shorter text goes to Overview.

Sections on the Sections tab are `<details>` cards. The first card starts open. A collapsed card shows the heading and one line. That line is the section `summary` when present, otherwise the first sentence of the body.

Text is inserted with `textContent`. The renderer does not use `innerHTML`. Section body text may include blank lines, `- `, `* `, or `• ` bullets, `## ` and `### ` subheadings, `**bold**`, and a short label at the start of a line such as `West wall:`. Those marks become elements. The characters stay text. An optional project `subtitle` is a smaller line under the H1. Omit it and the title stands alone.

`content.documents` is optional. Each entry is one package page (`id`, `heading`, optional `kicker`, optional `summary`, `blocks`) and is placed on Drawings ahead of a Page preview gallery. `summary` is accepted and stored on that section. Drawings shows the kicker, the heading, and the blocks with the page already open, so it does not render `summary`. Words a reader needs go in `blocks`. Block types are `heading` (level 2 or 3), `paragraph`, `list`, `table`, `callout`, `figure`, and `source`. Unknown fields and types are rejected at ingest and again when the presentation is validated. A `figure` block names an asset whose role is `figure`. A `source` block names a `source-page` asset and renders as a collapsed "View original page". Those two roles do not get their own gallery. `page-preview` still builds the Page preview gallery. When `content.documents` and `page-preview` assets are both present, `inspect` warns and names `source-page`. The warning does not by itself make the snapshot unpublishable. A submission with `page-preview` and no `documents` does not warn. Figures are lazy-loaded, use the document's alt text, open the existing lightbox, and are not stretched past the source pixels. A table sits in a horizontal scroller and stacks by row on a narrow screen. The same `textContent` rule applies inside every block. A submission with no `documents` array renders as before. The marks and the bounds are in [templates/section-text.md](templates/section-text.md).

A real project's widget link is labeled `Open 3D Kitchen Studio`. The fictional demo uses the block title instead. The link opens a new tab. It is not an iframe.

## Widgets

The widget is self-contained HTML, often produced by Antigravity. It is stored as a project asset and opened with `GET /api/projects/:id/widgets/:mediaId/open`. That route requires the project session. A widget that the presentation does not reference returns 404. `/media/` does not return HTML.

The response CSP is a sandbox with `allow-scripts`, `allow-downloads`, and `allow-popups`, `script-src` limited to inline scripts and `https://www.gstatic.com`, and `connect-src 'none'`. The sandbox origin is opaque, so the file cannot read the session cookie or call this API. The parent page does not listen for `postMessage` and does not embed the widget.

`seal` rejects HTML that reaches the network, except a script whose origin is `https://www.gstatic.com`. A gstatic Tailwind script is allowed and can be published as stored. `derive` is optional. It removes only the one unused script named by `APPROVED_UNUSED_SCRIPT` in `lib/content-policy.js`, into a new submission, and leaves the original bytes alone. Do not derive when the page needs that script. `seal` still rejects any other script host, a stylesheet link, a network call, a nested frame, or an `http` URL. The check is not a JavaScript sanitizer.

You may edit the hosted widget HTML for a phone layout only when every existing behavior still works. Remove the widget's own export buttons. DAE and PDF downloads are authenticated attachment links on the project page, not buttons inside the widget. DAE files use `model/vnd.collada+xml`, `Content-Disposition: attachment`, and `nosniff`.

## Content handoff

Allison hands off work through the private Drive folder named Allison Site Inbox. She does not need the Vercel CLI. A maintainer runs `import-drive` on a local copy of one submission folder, either a Google Drive for Desktop path or a downloaded copy, and follows [docs/publishing/WORKFLOW.md](docs/publishing/WORKFLOW.md). The command copies that folder into a fresh local stage, checks `READY.json`, and prints the inspect receipt. It leaves the source folder unchanged. `--seal` may seal the staged copy. `approve` and `publish` stay separate commands and still require the printed `snapshotDigest`. Editing Drive does not publish and does not activate a code. The folder name is not a project id.

There is no Google API client, watcher, webhook, poller, or cron. Do not add one. Do not put a client submission, its manifest, or a derived receipt in this repo. Do not connect this repo to that Drive folder from an agent turn.

`import-drive`, `inspect`, `derive`, `seal`, `approve`, `publish`, and `rollback` are the publishing path. Publish requires an approval bound to the printed `snapshotDigest`. Rollback does not restore codes.

Share codes may be plaintext in the shared Drive access file, a copy of `templates/project-access.json`. Import them with `import-codes` using production credentials. The repo template uses the placeholder `replace-with-a-code` and cannot be imported. Plaintext codes stay in that Drive folder only. Do not put a client code in the repo, `dist/`, a commit, a log, a URL, a doc, or chat. The non-secret demo fixture code lives in `lib/demo-fixture.js` for local tests. Do not copy it into docs or production, and do not set `DEMO_FIXTURE` on production.

Preview must not have the production database URL or Blob credentials. Hosted preview is fail-closed, and the CLI refuses `VERCEL_ENV=preview` before it connects. `AMC_TARGET` is only the operator's shell flag. The server still stores only an HMAC. Do not remove or edit Vercel environment variables from an agent turn.

## Secrets

Do not commit client identifiers, share codes, peppers, database URLs, or Blob tokens. Do not put them in docs, fixtures, or chat. Operational credentials stay in the host environment, separate from content.
