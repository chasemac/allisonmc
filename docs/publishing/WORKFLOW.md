# Publishing workflow

Allison's client work is not published by copying files into this repository. The private inbox is a separate Drive root that a person creates outside this repo. This document uses only placeholders. It contains no client names, project ids, submission ids, or codes.

The inbox is not Buckner Camp, and nothing in this repository authorizes publication from any existing folder.

## Status

| Piece | State |
| --- | --- |
| Public biography and musings | Built. Static files. |
| Code-gated project viewer | Built. Server checks every project and asset request. |
| Developer CLI (`scripts/projects.mjs`) | Built for developers. Not a content handoff and not a publisher. |
| Private Drive inbox | Specified here. Not connected. No watcher. |
| Manual ingestion, snapshot, approval, and publish pointer | Specified here. Not implemented. |
| External Drive webhook | Possible later. Not set up. Vercel's native routines do not provide a Drive trigger. |

Do not tell Allison to install Vercel CLI. Developers may keep using the CLI for the fictional demo and for test data. Client submissions do not go through it.

## Inbox shape

One registered project, one submission, ordinary files only:

```text
_inbox/<assigned-project-id>/<submission-id>/content.json
_inbox/<assigned-project-id>/<submission-id>/assets/<file>
_inbox/<assigned-project-id>/<submission-id>/READY.json
```

`<assigned-project-id>` must already exist in the private operational store. Creating a folder does not register a project. An unknown id is an error until someone registers it on purpose.

`<submission-id>` is chosen for that handoff. Uploading the same submission id again with different bytes is an error. A correction is a new submission.

## The only readiness protocol

`READY.json` is uploaded last, after `content.json` and every asset. It carries:

- the registered project id
- the submission id
- each expected relative path
- the byte size of that file
- the SHA-256 of that file

Anything else is not ready. Reject shortcuts, live Google Docs, and files that are only links to somewhere else. The importer, when it exists, reads each source file once into an immutable private snapshot and then checks the manifest, media types, file signatures, sizes, paths, and accidental secrets. Raster images should be re-encoded when that is practical. PDFs stay authenticated downloads until a later decision says otherwise.

`content.json` must fit the viewer schema. The page renders that JSON with the app's own components. It does not render uploaded JavaScript, HTML, MDX, Markdown source, or raw SVG. Plain text in a text block is the supported writing. Markdown is not a supported upload.

## Approval and publish

These steps are the intended manual procedure. No script in this repo performs them.

1. Seal the snapshot and record its digest.
2. Chase approves one operation, bound to the project id, that snapshot digest, and the operation. Approval of a different digest does not carry over.
3. Publish updates that project's current pointer in one compare-and-swap, or under a lock. The idempotency key is project id + submission id + snapshot digest. Repeating the same key is a no-op. The same submission id with different bytes is an error.
4. Record the publication in the private operational store. Do not write a shared published manifest into the site repo, the static build, or a public object.

Deleting or emptying the Drive submission does not unpublish. Unpublish and rollback only restore an earlier approved snapshot. Revoking a share code, or rotating a code, still takes effect after a rollback. Rollback does not restore a revoked code.

Share codes stay high-entropy values. The server stores an HMAC, not the code. Codes are not placed in URLs, logs, Drive, or public files. Rate limits and session checks stay in front of the viewer. Operational credentials (database, Blob, pepper) stay in the host environment and are not content.

A preview of unpublished work uses the same server checks as a published project. Every image and PDF request is authorized again. Responses are `private, no-store`, send no referrer, are not indexed, and are not run through public image optimization. The viewer does not load private analytics.

## What the running app already enforces

The viewer and the developer CLI already match the privacy rules that can be enforced without the importer:

- Client bytes are not part of the public site. `dist/` is HTML, CSS, the public images, and the client script. Server modules are not the static output.
- Presentation JSON is validated before it is stored or returned. Unknown block types, including HTML, are rejected.
- Media must match a JPEG, PNG, WebP, or PDF signature. SVG, HTML, script, Markdown, and MDX bytes are refused.
- PDF responses use an attachment download. Images are streamed only after the session check. The response does not include a Blob URL.
- Asset and JSON responses set `Cache-Control: private, no-store`, `Referrer-Policy: no-referrer`, and `X-Robots-Tag: noindex`.
- The site does not call a public image optimizer for private media and does not embed analytics.
- If the private stores or the rate limiter are unavailable, access fails closed.

The developer CLI can still write straight into the private store. That path has no snapshot digest, no approval record, and no compare-and-swap pointer. It must not be used as the publisher for a client submission.

## Not in this repository

- A Drive client, watcher, poller, or webhook
- Reading `READY.json`
- Snapshot storage, approval records, or a publication pointer
- Any client submission

Those stay absent until a later change implements the manual ingestion steps above without turning on a watcher.
