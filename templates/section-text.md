# Section text

This is the shape of a section inside `content.json`. It is not a client submission. Copy the fields into a real snapshot at republish time. A full document skeleton is in `templates/content.example.json`.

`title` on the document is the page heading. `subtitle` on the document is optional and is the smaller line under that heading. Leave `subtitle` out for a page that has only a heading.

Each entry in `content.sections` uses:

| Field | Required | Role |
| --- | --- | --- |
| `id` | yes | Stable section id. Not `meta-details`, `meta-notes`, or `role-…`. |
| `heading` | yes | Card heading. |
| `summary` | no | One line shown while the card is collapsed. Leave it out and the viewer uses the first sentence of `body`. |
| `body` | yes | The full section. Same facts as before. Layout marks below. No HTML. |

`body` is one string. The viewer inserts it with `textContent`. It does not parse HTML. Tags, scripts, and links in the string stay visible characters.

On the project page, a long section is a card on the Sections tab. `summary` is the one line while that card is collapsed. `title` is the H1. Optional `subtitle` is the smaller line under it. The page does not read `?project=`.

```text
Opening paragraph. A blank line starts the next block.

## West wall

- West wall: a 36" shelf on a 9'-0" run.
- South end: a 24" cabinet.

## North wall

- North wall: an 18" niche and a window, 3'-0" x 4'-0".

A later paragraph can name a 5'-0" x 2'-6" table. **Center:** two stools.
```

Marks:

- A blank line separates paragraphs.
- A line that starts with `## ` or `### ` is a subheading.
- A line that starts with `- `, `* `, or `• ` is a bullet. Keep one fact on each bullet.
- `**like this**` is bold. A short label at the start of a paragraph or bullet, such as `West wall:`, is also bold.
- Feet and inches stay written as they are, for example `36"`, `9'-0"`, `12'-2 1/2"`, `3'x4'`, and `5'-0" x 3'-0"`.

Group bullets by wall or zone. Do not drop a dimension or rename a measurement when regrouping. A long plain paragraph, with no marks, still shows in full. The card collapses it, and the viewer splits only very long prose into sentences so the line length stays readable.

## Concept pages

A package page that should reflow on a phone is a `documents` entry, not a longer `body`. `content.sections` stay as they are. Add `documents` beside `sections`. Leave `documents` out and an older snapshot renders as before.

Each document:

| Field | Required | Role |
| --- | --- | --- |
| `id` | yes | Stable id. Not `meta-details`, `meta-notes`, `role-…`, or another section id. |
| `heading` | yes | Page title. |
| `kicker` | no | Small line above the title, such as `THE PLAN`. |
| `summary` | no | One line. The Drawings tab shows the page open, so the words that must be read also belong in `blocks`. |
| `blocks` | yes | The page, in order. No HTML. |

Block types:

| `type` | Fields |
| --- | --- |
| `heading` | `level` is `2` or `3`. `text` is plain. |
| `paragraph` | `text`. Same marks as a section `body`. |
| `list` | `ordered` is `true` or `false`. `items` are strings. One fact each. Marks: `**bold**` and a `Label:` prefix. |
| `table` | `columns`, `rows`, optional `caption`. Every row has one cell per column. A cell may be `""`. |
| `callout` | `text`, optional `label`. `text` uses the same marks as a section `body`. |
| `figure` | `path` of an asset with role `figure`, `alt`, optional `caption`. |
| `source` | `path` of an asset with role `source-page`, `alt`, optional `label`. The viewer uses `View original page` when `label` is omitted. |

The page is inserted with `textContent`. Tags in a string stay visible characters. A figure is lazy-loaded, not stretched past its own pixel size, and opens the same lightbox as a gallery. A table scrolls inside its own frame and, on a narrow screen, stacks each row under its column name. The document goes on Drawings. `figure` and `source-page` do not also become galleries. A `page-preview` asset still becomes the Page preview gallery, so use `source-page` when the HTML page is the one to read and the flat PNG is only the original.

Bounds, all inclusive: 12 documents, 80 blocks, 40 list items, 8 table columns, 40 table rows. Headings 200 characters, paragraphs and callouts 4000, list items 2000, table cells 400, column names 80, alt and captions 300, labels 80, kickers 160. Unknown fields and unknown block types are rejected. Every `figure` and `source-page` file has to be named by a block.

For Antigravity or Muse: transcribe the page. Do not redraw sentences as an image. Photos, renderings, plan drawings, and elevations are `figure` crops. A dimension printed inside a drawing may stay in that crop; repeat the same words in a paragraph, list, or table so a phone can read them. Do not drop, reword, or invent a measurement. Keep the PDF as a `downloadable-pdf`. The flat page PNG, when you still ship it, is `source-page` plus a `source` block at the end of that document.
