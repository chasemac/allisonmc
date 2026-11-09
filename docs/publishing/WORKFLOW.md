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

Production and preview share that one database. A code is stored as `HMAC-SHA256(CODE_PEPPER, normalized code)`. Importing or rotating with the preview pepper writes hashes the production pepper will not recognize, and the other way around. Do not point the preview pepper at this database.

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

`content.json` is the only JSON document. Its fields are `projectId`, `submissionId`, `title`, `client`, `location`, `preparedBy`, `date`, `notesForReviewers`, `content`, and `assets`. `content` is `{ summary, sections: [{ id, heading, body }] }`. Each asset is `{ path, role, note }`. Paths start with `assets/` and contain no `..`.

Roles:

| Role | File |
| --- | --- |
| `interactive-3d-viewer` | one self-contained `.html` widget |
| `downloadable-3d-model` | `.dae` download |
| `downloadable-pdf` | `.pdf` download |
| `hero`, `3d-preview`, `gallery`, `page-preview`, `plan-sheet`, `proposal-preview`, `punchlist-preview`, `reference-photo` | `.png`, `.jpg`, `.jpeg`, or `.webp` |

Every asset path must exist, and every file except `READY.json` and `DERIVED.json` must be listed. The counts have to match. The media id is the basename without its extension. Two files that would share that id are rejected. Names match `^[A-Za-z0-9._-]{1,80}$`. Each file must be at most 20 MB. A short signature prefix is not a full sanitizer.

A validated handoff of 31 files is `content.json`, one HTML widget, two DAE files, four PDFs, 21 PNGs, and two JPEGs. The roles on those images come from `content.json`. This repository does not contain that handoff, and this branch does not publish it.

The viewer adds a details section and a notes section when those fields are present, then one section per role that has files. Generated section ids are `meta-details`, `meta-notes`, and `role-<role>`. A content section must not use those ids. The mapped page is `fictional: false`. Text is rendered as text. The widget is an iframe. DAE and PDF entries are authenticated downloads.

## Widget and the derived snapshot

`seal` rejects an HTML file that is not self-contained. An `https` script, stylesheet link, network call, nested frame, or any `http` URL fails the check. The response CSP stays `connect-src 'none'`. Do not widen it to make a remote script load.

The unused Tailwind script is removed only by `derive`, which writes a new directory and a new submission id. It does not download the script, and it does not change the original directory or the original `READY.json`. The new directory contains `DERIVED.json`:

- `derivedFrom.snapshotDigest` — canonical digest of the original file list
- `derivedFrom.manifestDigest` — the original `READY.json` digest field, when present
- `outputDigest` — canonical digest of the derived file list
- `operation` — `strip-unused-external-scripts`
- `published` — `false`

If anything external remains after that one strip, `derive` fails and nothing is sealed. Inspect the derived directory and approve `outputDigest` / `snapshotDigest` from that inspection. The original snapshot stays unsealed.

A widget is served only for a session on that project, only when `Sec-Fetch-Dest` is `iframe` and `Sec-Fetch-Site` is `same-origin`, and only when the HTML still passes the check. The iframe is `sandbox="allow-scripts allow-downloads"` with `referrerpolicy="no-referrer"`. It is not `allow-same-origin`. `/media/` does not return HTML. DAE files use `model/vnd.collada+xml`, `Content-Disposition: attachment`, and `nosniff`. A DAE with a doctype, entity, or external `init_from` is rejected. A relative `init_from` must name a file in the submission. The parent page does not listen for `postMessage`.

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

`seal` stores bytes at `projects/{projectId}/snap/{digest}/{mediaId}` and does not move the publication pointer. `publish` requires an approval for that project, submission, and digest. Repeating it is a no-op. A different digest is an error. `put-project` and `put-media` are not this path.

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
