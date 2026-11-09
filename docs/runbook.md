# Private project runbook

This file describes the viewing app and the developer CLI. It is not Allison's content handoff. That handoff is specified in [publishing/WORKFLOW.md](publishing/WORKFLOW.md) and is not built yet. Do not treat `put-project` as publication.

Operators with the developer CLI can seed the fictional demo and maintain test data. Allison does not get a dashboard, a Vercel install, or an account. Clients do not create accounts.

## What a client sees

`/view` asks for a code. A valid code sets an HttpOnly, SameSite=Strict session cookie scoped to one project. The page then shows that project's sections, a gallery with a lightbox, and any approved files or `https` links. Text is inserted as text, not HTML. Leaving the project revokes that session.

The session lasts at most 12 hours and never longer than the code. Every project, media, and file request checks the session, the code expiry, and the revocation flag. A session for one project gets a not-found response for another project's id.

Codes are 32 random bytes. Postgres stores only `HMAC-SHA256(CODE_PEPPER, code)`. The raw code is printed once by `issue-code` and is not written to git, the state file, URLs, or logs. Requests that put `code` in the query string are rejected.

Rate limiting is an atomic Postgres upsert shared by every function instance. The default is 8 attempts per 10 minutes per IP. If that write fails, or the database is not configured, the attempt is denied.

Media bytes live in a private Blob store under `projects/{projectId}/media/{mediaId}`. The browser never receives a Blob URL. The function streams the object only after the session check. Before a session cookie is set, the server asks the media adapter to confirm that private storage is reachable. If that check fails, no session is granted. A later media error on an existing session also fails closed and returns no bytes.

The upload check is a short signature prefix, not a full file parse and not a sanitizer. JPEG, PNG, WebP, and PDF prefixes are accepted. SVG, HTML, script, Markdown, and MDX text do not match those prefixes and are refused. A matching prefix does not prove the rest of the file is harmless. Images are served with nosniff and a locked content security policy. PDFs are downloaded rather than shown as active page content. A project file can contain plain text, galleries, private files, and curated `https` links. It cannot contain an HTML or script block. Markdown is not rendered.

`npm test` uses the in-memory store and a stub Blob client. It does not connect to Neon or Vercel Blob, and it is not a hosted check.

## What has to exist first

Nothing below is created by the repository.

1. A Vercel project for this repo, framework Other, build `node scripts/prepare-static.mjs`, output `dist`. Use a preview deployment. Do not add `allisonmc.com`.
2. A **private** Blob store connected to that project (`access: private`). Public Blob is the wrong store. Connecting it provides `BLOB_STORE_ID` and OIDC on Vercel. Create a read-write token only for the operator laptop and keep it in `.env.local`.
3. A Neon Postgres database from the Vercel Marketplace, or an existing database. Put its connection string in `DATABASE_URL`. The operator role needs to create the tables in this runbook.
4. `CODE_PEPPER`: at least 32 random characters, different in preview and production, stored only as a Vercel environment variable.
5. `DATA_STORE=postgres` and `MEDIA_STORE=blob` on the Vercel project.

`npm start` does not use these services. A preview without them serves the public pages and returns 503 for `/api/access`.

## Developer commands

These commands talk to Postgres and private Blob from a trusted machine. They do not read Drive, seal a snapshot, or move a publication pointer. Do not use them to publish a client submission. `.env.local` is filled from `.env.example` and never committed.

```bash
node scripts/projects.mjs migrate --store remote
node scripts/projects.mjs put-project --store remote --file path/to/project.json
node scripts/projects.mjs put-media --store remote --project project-id --id sheet-1 --file path/to/sheet.jpg
node scripts/projects.mjs issue-code --store remote --project project-id --days 30 --label "delivery"
node scripts/projects.mjs revoke-code --store remote --id CODE_ID
node scripts/projects.mjs revoke-codes --store remote --project project-id
node scripts/projects.mjs list --store remote --project project-id
```

`issue-code` prints the code once. Copy it into a password manager and send it to the client with the preview or, later, production `/view` URL. `--days` is required in spirit: the default is 30 and the maximum is 365. There is no permanent code.

`--store memory --state data/dev.json` is a local scratch file for trying the CLI. `data/` is gitignored. Do not point it at a real client project and then commit the file.

## Fictional demo

`fixtures/demo/` and `lib/demo-fixture.js` are a labeled fake project for tests and screenshots. The fixture code is non-secret and is published in that module on purpose.

```bash
node scripts/projects.mjs seed-demo --store remote
```

Set `DEMO_FIXTURE=1` only on a preview where that known code should work. `seed-demo` refuses `VERCEL_ENV=production`. Do not set `DEMO_FIXTURE` on production. The demo must not be described as Allison's work.

## Project file

`id` is lowercase letters, numbers, and hyphens. `fictional` is `true` or `false` and is required. Sections contain `text`, `gallery`, and `attachment` blocks. File attachments point at a media id already uploaded with `put-media`. Link attachments are absolute `https` URLs without a username or password. The validator drops every other shape, including `html` blocks.

Real client files do not belong in this repository, in `dist/`, or in `assets/`.

## Checks before a preview is shared

- `npm test`
- `/` and `/musings.html` render the existing biography and musings
- `/api/access` is 503 until the private services are configured, then 401 for a wrong code
- `/lib/demo-fixture.js` and `/fixtures/demo/project.json` are not publicly served
- A code for project A cannot read project B's presentation or media
- Revoking a code stops an already issued session on the next request
