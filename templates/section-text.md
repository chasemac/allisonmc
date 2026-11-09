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

`body` is one string. The viewer escapes it. Tags, scripts, and links in the string stay visible characters.

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
- A line that starts with `## ` is a subheading. `### ` works the same way.
- A line that starts with `- `, `* `, or `• ` is a bullet. Keep one fact on each bullet.
- `**like this**` is bold. A short label at the start of a paragraph or bullet, such as `West wall:`, is also bold.
- Feet and inches stay written as they are, for example `36"`, `9'-0"`, `12'-2 1/2"`, `3'x4'`, and `5'-0" x 3'-0"`.

Group bullets by wall or zone. Do not drop a dimension or rename a measurement when regrouping. A long plain paragraph, with no marks, still shows in full. The card collapses it, and the viewer splits only very long prose into sentences so the line length stays readable.
