# Publishing workflow

Allison's client work is not copied into this repository. She puts a snapshot in the private Drive folder Allison Site Inbox. A maintainer copies a verified snapshot to a local directory and runs the commands below. There is no Drive watcher, poller, or webhook. Editing Drive does not publish files and does not activate a code. The folder name is not a project id. Do not connect this repo to that folder from an agent turn.

This document uses placeholders. It contains no client names, project ids, submission ids, digests, or codes.

## What is already provisioned

| Piece | State |
| --- | --- |
| Neon Postgres | Free database `lucky-pond-84293267` in `aws-us-east-1`. `DATABASE_URL` is set on Vercel production and preview. It is not in git. |
| Blob | Private store `store_Ce6NEE2VP8BkMGv8`. The canary read matches `BLOB_PRIVATE_CANARY_SHA256`. An unauthenticated read is rejected. The hash is not in git. |
| Peppers | Production and preview each have their own `CODE_PEPPER`. |
| Activation | Do not change `DATA_STORE` or `MEDIA_STORE` from an agent turn. If they are missing, `/api/access` returns 503. Production uses `postgres` and `blob` once a person has turned access on. Do not set them on preview. |

Preview must not hold the production database URL, Blob store id, or Blob token. A preview pepper plus those credentials can write a second HMAC and can seal or publish. Hosted preview is fail-closed in code, and the maintenance CLI refuses `VERCEL_ENV=preview` before it connects. `AMC_TARGET=production` only selects the operator's shell. It does not make a preview credential safe. Remove `DATABASE_URL`, `BLOB_STORE_ID`, and Blob tokens from the Vercel Preview environment. Do not remove them from Production. This change does not edit those variables.

The maintenance CLI for a live project uses the production environment only:

```bash
AMC_TARGET=production
# plus that environment's DATABASE_URL, CODE_PEPPER, BLOB_STORE_ID, and Blob credential
```

The CLI refuses a remote command when `AMC_TARGET` is not `production`. `seed-demo` also refuses production. The process sets `DATA_STORE=postgres` and `MEDIA_STORE=blob` for that command only. It does not change the Vercel project. Do not set those two variables on preview. Preview uses a different pepper and must not point at this database. Neon stays on the Free plan. Do not upgrade it.

Apply `db/schema.sql` from a reviewed copy. This repository does not run it.

## Inbox

Ordinary files only. Shortcuts, live Docs, and external links are not a submission. The folder name is not an identity. Register the project id before sealing.

```text
<snapshot>/content.json
<snapshot>/assets/<file>
<snapshot>/READY.json
```

`READY.json` is written last. It carries the project id, the submission id, and each file's path, size, and SHA-256. `inspect` reads the bytes once, checks those values, and prints `snapshotDigest`. That digest is SHA-256 of the UTF-8 JSON `{ projectId, submissionId, files }`, with files sorted by path and reduced to path, size, and SHA-256. If `READY.json` also has a `digest` field, `inspect` reports whether it matches. Approval uses the printed `snapshotDigest`.

Uploading the same submission id again with different bytes is an error. A correction is a new submission id.

## Document shape

`content.json` is the only JSON document. Its fields are `projectId`, `submissionId`, `title`, `subtitle`, `client`, `location`, `preparedBy`, `date`, `notesForReviewers`, `content`, and `assets`. `subtitle` is optional. `content` is `{ summary, sections: [{ id, heading, body, summary }] }`. A section `summary` is optional. Each asset is `{ path, role, note }`. Paths start with `assets/` and contain no `..`.

`title` is the page heading. `subtitle` is the smaller line under that heading. Leave `subtitle` out and the page shows only `title`, as before. On a phone the heading uses a smaller size either way.

Section `body` stays one string. Blank lines, `- ` lists, `## ` subheadings, and `**bold**` are layout marks, not HTML. The page escapes the characters and does not run markup from the string. `summary` is the one line on a collapsed section card. Leave it out and the page uses the first sentence. A shape example is [templates/content.example.json](../../templates/content.example.json). The marks are written out in [templates/section-text.md](../../templates/section-text.md).

Roles:

| Role | File |
| --- | --- |
| `interactive-3d-viewer` | one self-contained `.html` widget |
| `downloadable-3d-model` | `.dae` download |
| `downloadable-pdf` | `.pdf` download |
| `hero`, `3d-preview`, `gallery`, `page-preview`, `plan-sheet`, `proposal-preview`, `punchlist-preview`, `reference-photo` | `.png`, `.jpg`, `.jpeg`, or `.webp` |

Every asset path must exist, and every file except `READY.json` and `DERIVED.json` must be listed. The counts have to match. The media id is the basename without its extension. Two files that would share that id are rejected. Names match `^[A-Za-z0-9._-]{1,80}$`. Each file, including HTML and DAE, must be at most 20 MB. The size is checked before the file is read into a buffer. A short signature prefix is not a full sanitizer. A DAE `init_from` must be the exact path of another file in the submission. Suffix matches, CDATA, doctypes, entities, and external URLs are rejected. The parser does not load or execute XML.

A validated handoff of 31 files is `content.json`, one HTML widget, two DAE files, four PDFs, 21 PNGs, and two JPEGs. The roles on those images come from `content.json`. This repository does not contain that handoff. Publishing it is the CLI sequence below, from a local copy, not a commit.

The viewer adds a details section and a notes section when those fields are present, then one section per role that has files. Generated section ids are `meta-details`, `meta-notes`, and `role-<role>`. A content section must not use those ids. The mapped page is `fictional: false`. Text is rendered as text. A widget is a link to its full page, not an embedded frame. DAE and PDF entries are authenticated downloads.

## Widget and the derived snapshot

`seal` rejects an HTML file that is not self-contained, except a script whose origin is `https://www.gstatic.com`. Any other script host, stylesheet link, network call, nested frame, or `http` URL fails that check. The check is not a JavaScript sanitizer.

A script loaded from `https://www.gstatic.com` can be sealed and published as stored. `derive` is optional for that file. `derive` removes only the one approved unused Tailwind script named by `APPROVED_UNUSED_SCRIPT`. Any other external script, including one the page needs, is left in place and the command fails. It writes a new directory and a new submission id. It refuses a symlink output, does not follow links into the original, and does not change the original directory or the original `READY.json`. The new directory contains `DERIVED.json`:

- `derivedFrom.snapshotDigest` — canonical digest of the original file list
- `derivedFrom.manifestDigest` — the original `READY.json` digest field, when present
- `outputDigest` — canonical digest of the derived file list
- `operation` — `strip-unused-external-scripts`
- `published` — `false`

If anything external remains after that one strip, `derive` fails and nothing is sealed. Inspect the derived directory and approve `outputDigest` / `snapshotDigest` from that inspection. The original snapshot stays unsealed.

The project page links to `GET /api/projects/{projectId}/widgets/{mediaId}/open`. For a real project the link text is `Open 3D Kitchen Studio`. The fictional demo uses the block title. The route requires the project session and returns the stored HTML unchanged. On a 200 response the function sets these headers and no others:

- `Content-Type: text/html; charset=utf-8`
- `Content-Security-Policy: sandbox allow-scripts allow-downloads allow-popups; default-src 'none'; script-src 'unsafe-inline' https://www.gstatic.com; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'`
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: no-referrer`
- `Cache-Control: private, no-store`
- `X-Robots-Tag: noindex`

That policy has no `frame-ancestors` directive. The sandbox list does not include `allow-same-origin`, so the document origin is opaque and the file cannot read the session cookie or call this API. The response does not set `X-Frame-Options` or `Cross-Origin-Resource-Policy`. A missing session is a JSON 401 whose policy is `default-src 'none'; sandbox`, also without `frame-ancestors` or `X-Frame-Options`. The parent page does not embed the widget and does not listen for `postMessage`.

`/media/` does not return HTML. Image, PDF, and DAE responses from `/media/` and file `/attachments/` set `Content-Type` to the stored type (`image/png`, `image/jpeg`, `image/webp`, `application/pdf`, or `model/vnd.collada+xml`), `Content-Security-Policy: default-src 'none'; sandbox`, `Cross-Origin-Resource-Policy: same-origin`, `X-Content-Type-Options: nosniff`, `Cache-Control: private, no-store`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex`, and `Content-Disposition` (`inline` for an image, `attachment` for a PDF or DAE, with the safe filename). They do not set `X-Frame-Options` or `frame-ancestors`. A DAE with a doctype, entity, or external `init_from` is rejected. A relative `init_from` must name a file in the submission.

`vercel.json` sends `X-Frame-Options: DENY` and a page policy that includes `frame-ancestors 'none'` only for paths matching `/((?!api/).*)`. The `/api/(.*)` header block sends `Cache-Control: private, no-store`, `X-Robots-Tag: noindex`, and `Referrer-Policy: no-referrer`. It does not send `X-Frame-Options` or a content security policy. Those page headers do not restrict framing of the widget open response or of media responses.

A gstatic script may stay in the hosted widget. Edit that HTML for a phone layout only when the existing behavior still works. Remove the widget's own export buttons. DAE and PDF downloads are the authenticated links on the project page.

## Commands

`inspect` and `derive` read a local directory and do not touch the database. `register-project` creates a placeholder and publishes nothing. Register the project id before the first seal.

```bash
node scripts/projects.mjs inspect --dir /path/to/snapshot
node scripts/projects.mjs derive --dir /path/to/original --out /path/to/derived --submission new-submission-id
AMC_TARGET=production node scripts/projects.mjs register-project --store remote --project project-id --title "Title from content.json"
AMC_TARGET=production node scripts/projects.mjs seal --store remote --dir /path/to/snapshot
AMC_TARGET=production node scripts/projects.mjs approve --store remote --project project-id --submission submission-id --digest snapshotDigest --operation publish
AMC_TARGET=production node scripts/projects.mjs publish --store remote --project project-id --submission submission-id --digest snapshotDigest
```

The live sequence after `inspect` is `seal`, then `approve --operation publish`, then `publish`. Use the `snapshotDigest` that `inspect` printed. Do not approve a differently computed manifest digest.

Printed receipts:

| Command | Prints |
| --- | --- |
| `inspect` | `project`, `submission`, `snapshotDigest`, `manifestDigest`, `manifestDigestMatches`, `files`, `publishable`, `published: false`, then one tab-separated row per asset: `path`, `role`, `size`, the first 12 hex characters of that file's `sha256`, and `problems` (`none` when the asset has none). `content.json` is included in `files` and is not an asset row. The command does not print codes, notes, or file bytes. A database URL, pepper, session cookie, or JSON code inside a problem is redacted. |
| `derive` | `inputDigest`, `outputDigest`, `published: false`, plus `DERIVED.json` in the output directory |
| `seal` | `snapshotDigest`, `idempotent`, `published: false` |
| `approve` | `approved`, `published: false` |
| `publish` | `version`, `idempotent`, `published: true`, `codesChanged: false` |

`seal` stores bytes at `projects/{projectId}/snap/{digest}/{mediaId}` and writes the snapshot and its file list in one transaction. `publish` only moves the pointer after approval. The live page and every file are read from that pointer's snapshot. A media id that is not in the snapshot is not served, including one left behind by an older snapshot. Repeating a publish of the same digest is a no-op. `register-project` does not replace an existing presentation. `put-project` does not replace a published one.

## Republish

A correction is a new submission id and a new `READY.json`. Do not reuse a submission id with different bytes. `seal` rejects that as a digest conflict.

1. Copy the new snapshot out of Allison Site Inbox.
2. `node scripts/projects.mjs inspect --dir /path/to/snapshot` and keep the printed `snapshotDigest`.
3. `AMC_TARGET=production node scripts/projects.mjs seal --store remote --dir /path/to/snapshot`
4. `AMC_TARGET=production node scripts/projects.mjs approve --store remote --project project-id --submission submission-id --digest snapshotDigest --operation publish`
5. `AMC_TARGET=production node scripts/projects.mjs publish --store remote --project project-id --submission submission-id --digest snapshotDigest`
6. Run the verification below. Do not write the code into the command transcript, git, or chat.

`derive`, when used, is a new submission id as well. Inspect the derived directory and approve that directory's `snapshotDigest`.

Rollback restores an earlier sealed snapshot. It needs its own approval (`--operation rollback`) and the same digest. It does not restore a revoked or rotated code. Deleting the Drive folder does not unpublish.

## Verification

After a production publish, with the stores configured:

- `POST /api/access` with a wrong code returns 401 and the message `That code is not valid.`
- `POST /api/access` with the project's code in the JSON body returns 200 and a `project` object. The response must not echo the code.
- With that session cookie, `GET /api/projects/{projectId}/media/{mediaId}`, an attachment URL, or `/api/projects/{projectId}/widgets/{mediaId}/open` returns 200.
- The same cookie against another project's id returns 404.
- A request with no session against those asset routes returns 401.
- `?code=` on `/api/access` returns 400 and does not authenticate.

If `DATA_STORE` or `MEDIA_STORE` is missing, or the host is a preview deployment, `/api/access` returns 503 and sets no session. That is fail-closed, not a successful publish check.

Open `/` and `/musings.html` as well. They stay public and use Lato. The project page is `/view.html`. `?project=` is ignored. The code is what opens the project. The page has no Leave project button. 3D preview images are on Model & files, not Drawings.

## Codes

Allison can write client codes in Allison Site Inbox, in a copy of `templates/project-access.json`. The placeholder `replace-with-a-code` cannot be imported. Plaintext codes stay in that Drive folder only. They are not written to git, the static build, URLs, logs, docs, or chat.

A code becomes usable only after `import-codes`. That command is not content approval and it does not publish a submission.

```bash
AMC_TARGET=production node scripts/projects.mjs import-codes --store remote --file /path/to/project-access.json
AMC_TARGET=production node scripts/projects.mjs revoke-code --store remote --project project-id --code "client code"
AMC_TARGET=production node scripts/projects.mjs rotate-code --store remote --project project-id --from "old code" --to "new code"
```

Before the HMAC, the server normalizes NFC, trims, collapses spaces, and lowercases. Friendly codes are 6 to 64 characters of letters, digits, spaces, and hyphens, starting and ending with a letter or digit. Existing long tokens of 20 to 200 URL-safe characters still work. The same normalized code on the same project updates the label or expiry and leaves sessions in place. The same code on another project rejects the import and does not change the other project. A revoked code is not turned back on by importing it again. Rotate stores the new code first, then revokes the old one, so a collision does not revoke the old code. Anyone who has the code can open that project. Sessions, rate limits, expiry, and revocation are unchanged.

`issue-code` can still print a random code once. Prefer the access file when Allison chooses the code.

## Not in this repository

- A Drive client or watcher
- The client submission, its original manifest, or the derived receipt
- Database URLs, peppers, Blob tokens, or the canary hash
- A production deploy or a DNS change
