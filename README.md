# Allison McElroy

Personal site for Allison McElroy. The public pages are static. Client project viewing is a separate server-checked path and is not part of the public biography.

## Public pages

- `/` and `/index.html` — home
- `/musings.html` — musings, also available as `/musings` on Vercel
- `/view.html` — code form for a private project, also available as `/view` on Vercel

`allisonmc.com` already serves this site from Vercel. Mail still uses the existing iCloud records. This branch does not change DNS, mail, or production.

## Vercel static settings

| Setting | Value |
| --- | --- |
| Framework preset | Other |
| Root directory | repository root |
| Install command | `npm install` (default from the lockfile) |
| Build command | `node scripts/prepare-static.mjs` |
| Output directory | `dist` |
| Node.js | 22 or 24 |

`dist/` contains only HTML, CSS, client JS, images, and `CNAME`. Functions stay in `api/`. Do not deploy this branch to production from the agent.

After the first preview, confirm these URLs 404:

- `/lib/demo-fixture.js`
- `/fixtures/demo/project.json`
- `/server.mjs`

## Private projects

Clients open one curated project with a code. There is no account, admin site, or comment thread. A project can link to its widget, which opens as its own sandboxed page. What the server does is in [docs/runbook.md](docs/runbook.md).

Client files stay out of this repo. A maintainer publishes from a verified local snapshot with the commands in [docs/publishing/WORKFLOW.md](docs/publishing/WORKFLOW.md). `DATA_STORE` and `MEDIA_STORE` stay unset until that path is reviewed and a real project is ready, so hosted project access stays closed. Agent constraints are in [AGENTS.md](AGENTS.md).

- One Vercel Function (`api/handler.js`). `vercel.json` rewrites `/api/(.*)` to it so multi-segment paths such as `/api/projects/:id/media/:mid` are not dropped.
- Neon Postgres for projects, HMAC share-code hashes, sessions, and the shared rate limit
- Vercel Blob **private** store for media, read with `get(pathname, { access: "private" })` and streamed by the function after the session check
- No Clerk or other end-user auth product

If Postgres or Blob is missing or errors, project access returns 503 and does not grant a session. The in-memory adapter is for local tests only and is refused when `VERCEL=1` or `NODE_ENV=production`.

## Local preview

```bash
npm install
npm test
npm start
```

`npm start` serves the public pages and the fictional demo on `http://127.0.0.1:4173` with the memory adapter. It does not contact Vercel, Neon, or Blob. `npm test` is the same kind of local check: in-memory data and a stub Blob client, not a hosted integration. A real preview also needs the private Blob canary described in [docs/runbook.md](docs/runbook.md). The canary is not created here.

## Mail and DNS

`allisonmc.com` mail uses iCloud MX and TXT records. Leave those records in place. The current nameservers (`ns-cloud-a1` through `ns-cloud-a4.googledomains.com`) do not identify the registrar or the DNS host. Confirm that host before any future record edit. Do not change nameservers, the apex, `www`, MX, or TXT as part of a preview.
