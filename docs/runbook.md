# Private project runbook

This file describes the viewing app and the developer CLI. It is not Allison's content handoff. That handoff is specified in [publishing/WORKFLOW.md](publishing/WORKFLOW.md) and is not built yet. Do not treat `put-project` as publication.

Operators with the developer CLI can seed the fictional demo and maintain test data. Allison does not get a dashboard, a Vercel install, or an account. Clients do not create accounts.

## What a client sees

`/view` asks for a code. A valid code sets an HttpOnly, SameSite=Strict session cookie scoped to one project. The page then shows that project's sections, a gallery with a lightbox, a link that opens a widget in a new tab when the project has one, and any approved files or `https` links. Text is inserted as text, not HTML. The widget page is not embedded. Its response CSP sandboxes it so it does not share the parent origin. The page does not show a leave button. `POST /api/logout` still revokes a session.

The session lasts at most 12 hours and never longer than the code. Every project, media, widget, and file request checks the session, the code expiry, and the revocation flag. A session for one project gets a not-found response for another project's id.

Postgres stores only `HMAC-SHA256(CODE_PEPPER, normalized code)`. Friendly codes and the older long random tokens both use that hash. `issue-code` prints a random code once. `import-codes` reads a Drive access file and does not print the codes. Codes are not written to git, the state file, URLs, or logs. Requests that put `code` in the query string are rejected. Production and preview have different peppers and share one database, so maintenance of live codes uses the production pepper. See [publishing/WORKFLOW.md](publishing/WORKFLOW.md).

Rate limiting is an atomic Postgres upsert shared by every function instance. The default is 8 attempts per 10 minutes per IP. If that write fails, or the database is not configured, the attempt is denied.

Media bytes live in a private Blob store under `projects/{projectId}/media/{mediaId}`. The browser never receives a Blob URL. The function streams the object only after the session check. Before a session cookie is set, the server reads a provisioned canary with `access: "private"` and checks its SHA-256. A store that merely answers, including a reachable public store, does not pass. A missing canary, a hash mismatch, the wrong store, or an auth failure grants no session. A later media error on an existing session also fails closed and returns no bytes.

The upload check for images and PDFs is a short signature prefix, not a full file parse and not a sanitizer. JPEG, PNG, WebP, and PDF prefixes are accepted. SVG, script, Markdown, and MDX text do not match those prefixes and are refused. A matching prefix does not prove the rest of the file is harmless. Images are served with nosniff and a locked content security policy. PDFs and DAE files are downloaded rather than shown as active page content. A widget HTML file is a separate checked path: it is not served from `/media/`, and it opens only from the session-gated widget link. Markdown is not rendered.

`npm test` uses the in-memory store and a stub Blob client. It does not connect to Neon or Vercel Blob, and it is not a hosted check.

## What has to exist first

The database, private Blob store, canary, and both peppers already exist. `DATA_STORE` and `MEDIA_STORE` are still unset, so the live function returns 503 for project access. Do not set them until `db/schema.sql` is applied and a real project is ready, and then set them on production only.

1. The Vercel project uses framework Other, build `node scripts/prepare-static.mjs`, and output `dist`. The domain already points here. Do not change DNS or mail.
2. Blob store `store_Ce6NEE2VP8BkMGv8` is private and connected to this project. On Vercel, each request asks for a fresh OIDC token. A laptop uses `BLOB_READ_WRITE_TOKEN` in `.env.local` for that same store. An inherited `VERCEL_OIDC_TOKEN` is not used for the laptop unless `BLOB_AUTH=oidc` is set on purpose.
3. The private canary at `projects/_access/private-canary` matches `BLOB_PRIVATE_CANARY_SHA256`. The hash stays out of git. Sessions stay closed until a private read matches.
4. Neon database `lucky-pond-84293267` (`aws-us-east-1`, Free). `DATABASE_URL` is already on production and preview. Apply the reviewed statements in `db/schema.sql` before enabling the stores. This repository does not apply them.
5. `CODE_PEPPER` differs by environment. Preview must not also have the production database URL, `BLOB_STORE_ID`, or a Blob token. Hosted preview is refused even if those values are present. Remove them from the Vercel Preview environment; leave Production as it is. This repository does not change those variables.
6. Leave `DATA_STORE` and `MEDIA_STORE` unset on Vercel until activation. Set them on production only, after `db/schema.sql` is applied. The operator CLI sets them in its own process and refuses `VERCEL_ENV=preview`.

`npm start` does not use these services. It serves the public pages and the fictional demo. Hosted `/api/access` stays 503 while the two store variables are unset.

## Developer commands

Remote commands talk to Postgres and private Blob from a trusted machine. They do not read Drive. `.env.local` is filled from `.env.example` and never committed. For a live project, that file must hold the production `DATABASE_URL`, production `CODE_PEPPER`, and the private Blob credential. `AMC_TARGET=production` is required. A preview pepper against the shared database is refused by policy even if the flag is wrong: the process can only see the pepper it was given, so load the production values on purpose.

Publishing commands are in [publishing/WORKFLOW.md](publishing/WORKFLOW.md). `put-project` and `put-media` still write straight to the current project and are not the publisher. `migrate` applies the same statements as `db/schema.sql`; prefer applying the reviewed SQL file first.

```bash
AMC_TARGET=production node scripts/projects.mjs list --store remote --project project-id
AMC_TARGET=production node scripts/projects.mjs import-codes --store remote --file /path/to/project-access.json
AMC_TARGET=production node scripts/projects.mjs revoke-code --store remote --project project-id --code "client code"
AMC_TARGET=production node scripts/projects.mjs rotate-code --store remote --project project-id --from "old code" --to "new code"
```

`issue-code` prints a random code once. `--days` defaults to 30 and the maximum on that command is 365. An access file may set `expiresOn` up to 1095 days. There is no permanent code. `import-codes` does not print the code.

`--store memory --state data/dev.json` is a local scratch file for trying the CLI. `data/` is gitignored. Do not point it at a real client project and then commit the file.

## Fictional demo

`fixtures/demo/` and `lib/demo-fixture.js` are a labeled fake project for tests and screenshots. The fixture code is non-secret and is published in that module on purpose.

```bash
node scripts/projects.mjs seed-demo --store memory
```

Set `DEMO_FIXTURE=1` only on a preview where that known code should work. `seed-demo` refuses `VERCEL_ENV=production` and `AMC_TARGET=production`. Do not set `DEMO_FIXTURE` on production. The demo must not be described as Allison's work.

## Project file

`id` is lowercase letters, numbers, hyphens, and underscores. `fictional` is `true` or `false` and is required. Sections contain `text`, `gallery`, `widget`, and `attachment` blocks. File attachments point at a media id. Link attachments are absolute `https` URLs without a username or password. Arbitrary HTML blocks are still rejected. A widget block only names a media id that the server has already checked.

Real client files do not belong in this repository, in `dist/`, or in `assets/`.

## Checks before a preview is shared

- `npm test`
- `/` and `/musings.html` render the existing biography and musings
- `/api/access` is 503 until the private services are configured, then 401 for a wrong code
- `/lib/demo-fixture.js` and `/fixtures/demo/project.json` are not publicly served
- A code for project A cannot read project B's presentation or media
- Revoking a code stops an already issued session on the next request
