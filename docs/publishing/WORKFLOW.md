# Publishing workflow

Allison's client work is not copied into this repository. A person keeps the submission in a private Drive folder and a maintainer runs the commands below from a verified local copy. There is no Drive watcher, poller, or webhook. Editing Drive does not publish files and does not activate a code.

This document uses placeholders. It contains no client names, project ids, submission ids, digests, or codes.

## What is already provisioned

| Piece | State |
| --- | --- |
| Neon Postgres | Free database `lucky-pond-84293267` in `aws-us-east-1`. `DATABASE_URL` is set on Vercel production and preview. It is not in git. |
| Blob | Private store `store_Ce6NEE2VP8BkMGv8`. The canary read matches `BLOB_PRIVATE_CANARY_SHA256`. An unauthenticated read is rejected. The hash is not in git. |
| Peppers | Production and preview each have their own `CODE_PEPPER`. |
| Activation | `DATA_STORE` and `MEDIA_STORE` stay unset on Vercel. `/api/access` stays 503 until those two are set after review. |

Preview must not hold the production database URL, Blob store id, or Blob token. A preview pepper plus those credentials can write a second HMAC and can seal or publish. Hosted preview is fail-closed in code, and the maintenance CLI refuses `VERCEL_ENV=preview` before it connects. `AMC_TARGET=production` only selects the operator's shell. It does not make a preview credential safe. Remove `DATABASE_URL`, `BLOB_STORE_ID`, and Blob tokens from the Vercel Preview environment. Do not remove them from Production. This change does not edit those variables.

The maintenance CLI for a live project uses the production environment only:

```bash
AMC_TARGET=production
# plus that environment's DATABASE_URL, CODE_PEPPER, BLOB_STORE_ID, and Blob credential
```

The CLI refuses a remote command when `AMC_TARGET` is not `production`. `seed-demo` also refuses production. The process sets `DATA_STORE=postgres` and `MEDIA_STORE=blob` for that command. It does not change the Vercel project. Leave those two variables unset on Vercel until `db/schema.sql` has been applied and a real project is ready. When that happens, set them on production only. Do not set them on preview while preview uses a different pepper against this database.

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

A validated handoff of 31 files is `content.json`, one HTML widget, two DAE files, four PDFs, 21 PNGs, and two JPEGs. The roles on those images come from `content.json`. This repository does not contain that handoff, and this branch does not publish it.

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

The project page links to `GET /api/projects/{projectId}/widgets/{mediaId}/open`. That route requires the project session and returns the stored HTML unchanged. The response CSP is a sandbox with `allow-scripts`, `allow-downloads`, and `allow-popups`, `script-src` limited to inline scripts and `https://www.gstatic.com`, and `connect-src 'none'`. The sandbox origin is opaque, so the file cannot read the session cookie or call this API. `/media/` does not return HTML. DAE files use `model/vnd.collada+xml`, `Content-Disposition: attachment`, and `nosniff`. A DAE with a doctype, entity, or external `init_from` is rejected. A relative `init_from` must name a file in the submission. The parent page does not listen for `postMessage`.

Page responses keep `X-Frame-Options: DENY` and `frame-ancestors 'none'`. Those headers are not applied to `/api/`, so the widget response can be framed by this origin only.

## Commands

`inspect` and `derive` read a local directory and do not touch the database.

```bash
node scripts/projects.mjs inspect --dir /path/to/snapshot
node scripts/projects.mjs derive --dir /path/to/original --out /path/to/derived --submission new-submission-id
```

The rest use the production environment. `register-project` creates a placeholder and publishes nothing.

```bash
AMC_TARGET=production node scripts/projects.mjs register-project --store remote --project project-id --title "Title from content.json"
AMC_TARGET=production node scripts/projects.mjs seal --store remote --dir /path/to/derived
AMC_TARGET=production node scripts/projects.mjs approve --store remote --project project-id --submission submission-id --digest snapshotDigest --operation publish
AMC_TARGET=production node scripts/projects.mjs publish --store remote --project project-id --submission submission-id --digest snapshotDigest
```

`seal` stores bytes at `projects/{projectId}/snap/{digest}/{mediaId}` and writes the snapshot and its file list in one transaction. `publish` only moves the pointer after approval. The live page and every file are read from that pointer's snapshot. A media id that is not in the snapshot is not served, including one left behind by an older snapshot. Repeating a publish is a no-op. `register-project` does not replace an existing presentation. `put-project` does not replace a published one.

Rollback restores an earlier sealed snapshot. It needs its own approval (`--operation rollback`) and the same digest. It does not restore a revoked or rotated code. Deleting the Drive folder does not unpublish.

## Codes

Allison can write client codes in the shared Drive folder, in a copy of `templates/project-access.json`. The placeholder `replace-with-a-code` cannot be imported. Plaintext codes stay in that shared folder only. They are not written to git, the static build, URLs, or logs.

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
