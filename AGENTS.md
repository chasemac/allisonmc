# Agent guide

This site is Allison McElroy's public biography plus a private, code-gated project viewer. Read [docs/publishing/WORKFLOW.md](docs/publishing/WORKFLOW.md) before any work on client content. Read [docs/runbook.md](docs/runbook.md) before changing access, storage, or the developer CLI.

## Public pages

Keep the existing biography, musings, profile photo, Behance portfolio link, and LinkedIn link until a person supplies new copy. Do not invent projects, credentials, quotes, or personal facts. The fictional demo under `fixtures/demo/` is a labeled test project, not her work, and it must stay labeled that way.

Public pages stay static HTML, CSS, and a small client script. Do not add a framework or an admin site for them.

## Private viewing, as built

A share code is redeemed by `POST /api/access` from the page script. The access page is not a form, and the field has no name, so a browser with JavaScript disabled cannot put the code in a URL. The server stores only an HMAC. It reads the private Blob canary and checks its digest before it sets an HttpOnly SameSite=Strict session for one project, then checks that session on every presentation, image, and PDF request. A public or merely reachable store is not enough. If leaving the project fails, the page stays on the project and says the session is still active. Responses use `Cache-Control: private, no-store`, `Referrer-Policy: no-referrer`, and `X-Robots-Tag: noindex`. Missing Postgres, Blob configuration, or rate-limit configuration fails closed. The in-memory adapter is for local tests and is refused on Vercel. Those tests do not call a live database or Blob store.

The page renders validated JSON with fixed components: text, galleries, attachment downloads, and a sandboxed widget iframe. Text is inserted as text. JPEG, PNG, WebP, and PDF are recognized by a short prefix, which is not a full parse or a sanitizer. The widget is a separate HTML document in an iframe with `sandbox="allow-scripts allow-downloads"` and no `allow-same-origin`. Its response CSP blocks network, cookies, storage, and parent access. PDFs and DAE files are authenticated downloads. JavaScript, MDX, Markdown files, and raw SVG are not generic uploads.

## Content handoff

Allison hands off work through a private Drive folder. She does not need the Vercel CLI. A maintainer copies a verified snapshot and runs the manual commands in [docs/publishing/WORKFLOW.md](docs/publishing/WORKFLOW.md). Editing Drive does not publish and does not activate a code.

Do not build or enable a Drive watcher, webhook, or poller. Do not put a client submission, its manifest, or a derived receipt in this repo. Do not treat a folder name as a registered project. Do not connect this repo to an existing Drive folder from an agent turn.

`inspect`, `derive`, `seal`, `approve`, `publish`, and `rollback` are the publishing path. `derive` removes an unused external script into a new submission and leaves the original bytes alone. `seal` rejects HTML that still reaches the network. Publish requires an approval bound to the printed snapshot digest. Rollback does not restore codes.

Share codes may be plaintext in the shared Drive access file. Import them with `import-codes` using the production `CODE_PEPPER`. Preview and production peppers are different and the database is shared, so the preview pepper must not write codes. The server still stores only an HMAC. `DATA_STORE` and `MEDIA_STORE` stay unset on Vercel until the reviewed SQL is applied and a real project is ready.

## Secrets and hosting

Do not commit client identifiers, share codes, peppers, database URLs, or Blob tokens. Do not put them in docs, fixtures, or chat. Operational credentials stay in the host environment, separate from content.

Do not attach `allisonmc.com`, change DNS, or edit mail records. iCloud MX and TXT stay as they are. Nameservers do not identify the registrar. Do not merge to production or disable GitHub Pages from an agent turn. `CNAME` stays until a person cuts over on purpose.
