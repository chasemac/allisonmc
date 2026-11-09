# Agent guide

This site is Allison McElroy's public biography plus a private, code-gated project viewer. Read [docs/publishing/WORKFLOW.md](docs/publishing/WORKFLOW.md) before any work on client content. Read [docs/runbook.md](docs/runbook.md) before changing access, storage, or the developer CLI.

## Public pages

Keep the existing biography, musings, profile photo, Behance portfolio link, and LinkedIn link until a person supplies new copy. Do not invent projects, credentials, quotes, or personal facts. The fictional demo under `fixtures/demo/` is a labeled test project, not her work, and it must stay labeled that way.

Public pages stay static HTML, CSS, and a small client script. Do not add a framework or an admin site for them.

## Private viewing, as built

A share code is redeemed by `POST /api/access`. The server stores only an HMAC of the code, sets an HttpOnly SameSite=Strict session for one project, and checks that session on every presentation, image, and file request. Responses use `Cache-Control: private, no-store`, `Referrer-Policy: no-referrer`, and `X-Robots-Tag: noindex`. Missing Postgres, Blob, or rate-limit configuration fails closed. The in-memory adapter is for local tests and is refused on Vercel.

The page renders validated JSON with fixed components: text, galleries, and attachments. Text is inserted as text. JPEG, PNG, WebP, and PDF are the only media signatures accepted. JavaScript, HTML, MDX, Markdown files, and raw SVG are not renderable uploads. PDFs are authenticated downloads.

## Content handoff, not built

Allison will hand off work through a private Drive inbox. She does not need the Vercel CLI. The developer CLI in `scripts/projects.mjs` may seed the fictional demo and maintain test data. It does not ingest Drive, and it is not publication.

Do not build or enable a Drive watcher, webhook, or poller unless a later request says to. Do not publish client files. Do not treat a folder name as a registered project. Do not connect this repo to any existing Drive folder, including Buckner Camp.

There is no importer, snapshot sealer, approval record, or publication pointer in the code today. Do not describe those as present.

## Secrets and hosting

Do not commit client identifiers, share codes, peppers, database URLs, or Blob tokens. Do not put them in docs, fixtures, or chat. Operational credentials stay in the host environment, separate from content.

Do not attach `allisonmc.com`, change DNS, or edit mail records. iCloud MX and TXT stay as they are. Nameservers do not identify the registrar. Do not merge to production or disable GitHub Pages from an agent turn. `CNAME` stays until a person cuts over on purpose.
