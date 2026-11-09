# Private project runbook

This file describes the viewing app and the developer CLI. Allison's content handoff is [publishing/WORKFLOW.md](publishing/WORKFLOW.md). `put-project` and `put-media` write straight to the current project and are not the publisher.

Operators with the developer CLI can seed the fictional demo and maintain test data. Allison does not get a dashboard, a Vercel install, or an account. Clients do not create accounts. There is no admin UI.

## What a client sees

The viewer is `/view.html`, also served as `/view`. `js/view.js` does not read `?project=`. Writing that query does not select a project. The visitor enters the shared code for one project. `POST /api/access` with JSON `{ "code": "..." }` redeems it. A `code` query parameter returns 400. The field is not a named form control, so a browser with JavaScript disabled cannot put the code in a URL.

A valid code sets an HttpOnly, SameSite=Strict session cookie (`amc_session`) scoped to that one project. On HTTPS the cookie is also `Secure`. The session lasts at most 12 hours and never longer than the code. The page then shows that project's tabs, galleries with a lightbox, a link that opens a widget in a new tab when the project has one, and any approved files or `https` links. Text is inserted with `textContent`, not HTML. The widget page is not embedded. Its response CSP sandboxes it so it does not share the parent origin. The page does not show a Leave project button. `POST /api/logout` still revokes a session. Do not add the button back unless a person asks.

Tabs are Overview, Sections, Drawings, and Model & files. On a narrow screen the tab list scrolls sideways. It does not wrap. A gallery whose section id is `role-3d-preview` or `3d-preview`, or whose title is `3D preview`, is placed on Model & files. Other image roles go to Drawings. Widget and file downloads go to Model & files.

The session is checked on every project, media, widget, and file request, along with the code expiry and the revocation flag. A session for one project gets 404 for another project's id. A missing or ended session gets 401 and the cookie is cleared. If the session store is unavailable, the response is 503 and the cookie stays.

Postgres stores only `HMAC-SHA256(CODE_PEPPER, normalized code)`. The code is NFC-normalized, trimmed, collapsed, and lowercased before the hash. Friendly codes and the older long random tokens both use that hash. `issue-code` prints a random code once. `import-codes` reads a Drive access file and does not print the codes. Codes are not written to git, the state file, URLs, logs, or chat. Production and preview have different peppers. Maintenance of live codes uses the production pepper. See [publishing/WORKFLOW.md](publishing/WORKFLOW.md).

Rate limiting is an atomic Postgres upsert shared by every function instance. The default is 8 attempts per 10 minutes per IP. An optional shared cap across every IP is off by default, because a default shared cap would let anyone lock real clients out; set `RATE_LIMIT_GLOBAL_MAX` (at least the per-IP max, at most 10000) to turn it on during an attack. A client that is already over its own limit does not keep adding to the shared count. On Vercel the address is the first hop of `x-vercel-forwarded-for`, which the platform sets. A client-supplied `x-forwarded-for` or `x-real-ip` is not used while that header is present. The local preview server ignores those headers and uses the socket address. If the rate-limit write fails, or the database is not configured, the attempt is denied.

`POST /api/access` accepts one JSON object of at most 2048 bytes. A larger body is rejected with 413 and does not set a session. A body that is not a JSON object is rejected with 400, and the parser error is not returned.

Media bytes live in a private Blob store. Published files are read from `projects/{projectId}/snap/{digest}/{mediaId}`. The browser never receives a Blob URL. The function streams the object only after the session check. Before a session cookie is set, the server reads a provisioned canary with `access: "private"` and checks its SHA-256. A store that merely answers, including a reachable public store, does not pass. A missing canary, a hash mismatch, the wrong store, or an auth failure grants no session. A later media error on an existing session also fails closed and returns no bytes.

The upload check for images and PDFs is a short signature prefix, not a full file parse and not a sanitizer. JPEG, PNG, WebP, and PDF prefixes are accepted. SVG, script, Markdown, and MDX text do not match those prefixes and are refused. A matching prefix does not prove the rest of the file is harmless. Images are served with nosniff and a locked content security policy. PDFs and DAE files are downloaded rather than shown as active page content. A widget HTML file is a separate checked path: it is not served from `/media/`, and it opens only from the session-gated widget link. Markdown is not rendered.

`npm test` uses the in-memory store and a stub Blob client. It does not connect to Neon or Vercel Blob, and it is not a hosted check.

## What has to exist first

The database, private Blob store, canary, and both peppers are the production services. Do not upgrade Neon off the Free plan. Do not change Vercel environment variables from an agent turn. Do not put production `DATABASE_URL`, `BLOB_STORE_ID`, or a Blob token on preview. Hosted preview is refused in code even if those values are present.

When `DATA_STORE` and `MEDIA_STORE` are unset, or the host is a Vercel preview, `/api/access` returns 503 and sets no session. When production has `DATA_STORE=postgres` and `MEDIA_STORE=blob`, a wrong code returns 401 and a valid code returns 200. The operator CLI sets those two variables in its own process for a remote command. It does not change the Vercel project, and it refuses `VERCEL_ENV=preview`.

1. The Vercel project is `allisonmc` on team `chasemacs-projects`, framework Other, Node.js 22, build `node scripts/prepare-static.mjs`, output `dist`. Production auto-deploys from `main`. DNS is a DNS-only cutover on Squarespace. Do not change DNS, nameservers, the registrar, or iCloud mail records.
2. Blob store `store_Ce6NEE2VP8BkMGv8` is private and connected to this project. On Vercel, each request asks for a fresh OIDC token. A laptop uses `BLOB_READ_WRITE_TOKEN` in `.env.local` for that same store. An inherited `VERCEL_OIDC_TOKEN` is not used for the laptop unless `BLOB_AUTH=oidc` is set on purpose.
3. The private canary at `projects/_access/private-canary` matches `BLOB_PRIVATE_CANARY_SHA256`. The hash stays out of git. Sessions stay closed until a private read matches.
4. Neon database `lucky-pond-84293267` (`aws-us-east-1`, Free). `DATABASE_URL` is not in git. Apply the reviewed statements in `db/schema.sql` from a reviewed copy before relying on the tables. This repository does not apply them. `migrate` runs the same statements. Prefer the reviewed SQL file.
5. `CODE_PEPPER` differs by environment. Preview must not also have the production database URL, `BLOB_STORE_ID`, or a Blob token.

`npm start` does not use these services. It serves the public pages and the fictional demo.

The build also does two things to the public pages in `dist/`. It adds `?v=<content hash>` to every `assets/` reference, so a replaced image gets a new URL despite the 30-day `/assets` cache. It refreshes the Lato preload links from Google's stylesheet, and keeps the committed links if Google can't be reached; `AMC_FONT_PRELOADS=skip` turns that off. `node scripts/lato-preloads.mjs --check` exits 1 when the committed links are stale; run it without `--check` to update them.

`test/noscript-submit.test.js` drives a real Chrome. It uses `CHROME_PATH`, then `google-chrome` or `chromium` on `PATH`, then the macOS Chrome app or a Playwright Chromium download, and is skipped only when none is found.

## Developer commands

Remote commands talk to Postgres and private Blob from a trusted machine. They do not call Google. `import-drive` reads a local directory the operator already has. Without `--seal` it does not open Postgres or Blob. With `--seal` it follows the same store rules as `seal` and still does not approve or publish. It reads the folder twice. A file whose size or SHA-256 changes between those reads stops the command with `still syncing, try again`. Run it again when the folder is stable. There is no watcher. `project-access.json` in the submission is refused unread. Codes stay in the separate access file. `.env.local` is filled from `.env.example` and never committed. For a live project, that file must hold the production `DATABASE_URL`, production `CODE_PEPPER`, and the private Blob credential. `AMC_TARGET=production` is required. A preview pepper against the shared database is refused.

Publishing commands, receipts, and the post-publish checks are in [publishing/WORKFLOW.md](publishing/WORKFLOW.md).

```bash
node scripts/projects.mjs import-drive --dir /path/to/drive-snapshot --out /path/to/fresh-stage
AMC_TARGET=production node scripts/projects.mjs import-drive --dir /path/to/drive-snapshot --out /path/to/fresh-stage --seal --store remote
AMC_TARGET=production node scripts/projects.mjs list --store remote --project project-id
AMC_TARGET=production node scripts/projects.mjs import-codes --store remote --file /path/to/project-access.json
AMC_TARGET=production node scripts/projects.mjs revoke-code --store remote --project project-id --code "client code"
AMC_TARGET=production node scripts/projects.mjs rotate-code --store remote --project project-id --from "old code" --to "new code"
```

`import-codes` reads the Drive copy of the access file. Do not import `templates/project-access.json` from the repo. The placeholder `replace-with-a-code` cannot be imported. The command does not print the code.

`issue-code` prints a random code once. `--days` defaults to 30 and the maximum on that command is 365. An access file may omit `expiresOn` (one year) or set it up to 1095 days. There is no permanent code. Do not commit the printed code.

`--store memory --state data/dev.json` is a local scratch file for trying the CLI. `data/` is gitignored. Do not point it at a real client project and then commit the file.

`node scripts/projects.mjs help` prints the same command list.

## Fictional demo

`fixtures/demo/` and `lib/demo-fixture.js` are a labeled fake project for tests and screenshots. The fixture code is non-secret and is published in that module on purpose. Do not copy it into docs, chat, or production.

```bash
node scripts/projects.mjs seed-demo --store memory
```

Set `DEMO_FIXTURE=1` only on a preview where that known code should work. `seed-demo` refuses `VERCEL_ENV=production` and `AMC_TARGET=production`. Do not set `DEMO_FIXTURE` on production. The demo must not be described as Allison's work.

## Project file

`id` is lowercase letters, numbers, hyphens, and underscores. `fictional` is `true` or `false` and is required. `title` is the heading. `subtitle` is optional and renders as a smaller line under it. Omit it and the heading stands alone. Sections contain `text`, `gallery`, `widget`, `attachment`, and `flow` blocks. A `flow` block is the mapped form of a `content.documents` page and is placed on Drawings. A section may include an optional `summary` line for its collapsed card, and an optional `kicker` line above the title. A document `summary` is stored on that Drawings section. The page is already open, so the viewer does not print it. Text may use blank lines, `- `, `* `, or `• ` lists, `## ` and `### ` subheadings, `**bold**`, and a short `Label:` prefix. Those marks are escaped text, inserted with `textContent`, not HTML. File attachments point at a media id. Link attachments are absolute `https` URLs without a username or password. Arbitrary HTML blocks are still rejected. A widget block only names a media id that the server has already checked.

`npm start` serves the fictional demo. `AMC_PREVIEW_DIR` plus `AMC_PREVIEW_CODE` also loads one local snapshot into that same memory process. The code is not written to the snapshot, the repo, or the log. The flag does nothing on Vercel, and it is not a publish path.

Real client files do not belong in this repository, in `dist/`, or in `assets/`.

## Typography

The hidden legacy pages use `css/styles.css`; the designer site uses `css/site.css`; the viewer uses `css/site.css` plus `css/portal.css`. The family is Lato 300, 400, and 700, including italics, with a system sans-serif fallback. Do not reintroduce Fraunces, Outfit, or another family unless a person asks.

## Checks before a preview is shared

- `npm test`
- `/` and the designer pages render in Lato with the Evergreen + Slate palette; `/legacy-home.html` and `/musings.html` still render the earlier biography and musings
- `/lib/demo-fixture.js` and `/fixtures/demo/project.json` are not publicly served
- `/api/access` is 503 when stores or the pepper are missing, on hosted preview, and when the private canary does not match
- When production stores are configured, a wrong code returns 401 and a valid code returns 200
- A code in the query string returns 400 and does not authenticate
- A code for project A cannot read project B's presentation or media
- Revoking a code stops an already issued session on the next request
