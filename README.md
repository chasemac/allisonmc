# Allison McElroy

Personal site for Allison McElroy. The public pages are static. Client project viewing is a separate server-checked path and is not part of the public biography.

Agent constraints are in [AGENTS.md](AGENTS.md). Runtime detail is in [docs/runbook.md](docs/runbook.md). Publishing commands are in [docs/publishing/WORKFLOW.md](docs/publishing/WORKFLOW.md).

## Public pages

- `/` and `/index.html` — home
- `/musings.html` — musings, also available as `/musings` on Vercel
- `/view.html` — code form for a private project, also available as `/view` on Vercel

Typography is Lato (300, 400, 700, and italics) on every page that shares `css/styles.css`, including the project viewer. Do not add another font family unless a person asks.

## Hosting

Production is the Vercel project `allisonmc` on team `chasemacs-projects`. A merge to `main` auto-deploys. Do not deploy from an agent. Review the pull request before merge, then check the live site after the deploy.

`allisonmc.com` is attached to that project. DNS is a DNS-only cutover on Squarespace. Do not change DNS records, nameservers, or the registrar. Mail still uses the existing iCloud MX and TXT records. Do not edit them. Leave the repo `CNAME` file in place. It is copied into `dist/` and is not the live DNS editor.

## Vercel static settings

| Setting | Value |
| --- | --- |
| Framework preset | Other |
| Root directory | repository root |
| Install command | `npm install` (default from the lockfile) |
| Build command | `node scripts/prepare-static.mjs` |
| Output directory | `dist` |
| Node.js | 22 |

`dist/` contains only HTML, CSS, client JS, images, and `CNAME`. Functions stay in `api/`.

These URLs stay 404:

- `/lib/demo-fixture.js`
- `/fixtures/demo/project.json`
- `/server.mjs`

## Private projects

Clients open one curated project with a shared code. There is no account, admin site, or comment thread. The page is `/view.html`. The script does not read `?project=`. The code selects the project. The server stores only an HMAC. Plaintext codes may live in the shared Drive publishing folder and must not be written to the repo, static files, commits, logs, or chat.

A project can link to its widget, which opens as its own sandboxed page at `/api/projects/:id/widgets/:mediaId/open`. The widget is not embedded.

What the server does is in [docs/runbook.md](docs/runbook.md). Client files stay out of this repo. A maintainer publishes from a verified local snapshot with the commands in [docs/publishing/WORKFLOW.md](docs/publishing/WORKFLOW.md).

The project heading is `title` in `content.json`. An optional `subtitle` is the smaller line under it. Each content section is `{ id, heading, body, summary }`. `summary` is optional and is the one line on a collapsed section card. `body` can include blank lines, lines that start with `- `, `## ` or `### ` subheadings, and `**bold**` or a `Label:` prefix. The page inserts that text with `textContent`. It does not accept HTML in the body. Older snapshots that have only `title` and a plain `body` still render. An optional `content.documents` list is a concept page as headings, paragraphs, lists, tables, callouts, and figures. The field list is in [templates/content.example.json](templates/content.example.json), and the body marks are in [templates/section-text.md](templates/section-text.md).

- One Vercel Function (`api/handler.js`). `vercel.json` rewrites `/api/(.*)` to it so multi-segment paths are not dropped.
- Neon Postgres, Free plan only. Do not upgrade it to a paid plan. It holds projects, HMAC share-code hashes, sessions, and the shared rate limit.
- Vercel Blob **private** store for media, read with `get(pathname, { access: "private" })` and streamed by the function after the session check.
- No Clerk or other end-user auth product.

If Postgres or Blob is missing or errors, or the request is a hosted preview, project access returns 503 and does not grant a session. When production stores are configured, a wrong code returns 401 and a valid code returns 200. The in-memory adapter is for local tests only and is refused when `VERCEL=1` or `NODE_ENV=production`.

## Local preview

```bash
npm install
npm test
npm start
```

`npm start` serves the public pages and the fictional demo on `http://127.0.0.1:4173` with the memory adapter. It does not contact Vercel, Neon, or Blob. Set `AMC_PREVIEW_DIR` to a local snapshot and `AMC_PREVIEW_CODE` to a throwaway code to load that snapshot in the same local process. That flag is refused on Vercel and does not publish. `npm test` is the same kind of local check: in-memory data and a stub Blob client, not a hosted integration. A real preview also needs the private Blob canary described in [docs/runbook.md](docs/runbook.md). The canary is not created here.
