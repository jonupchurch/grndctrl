# The design files, and what 0.4.0 did to them

Three exported documents, and they are **records rather than specifications**.
They were the design the first board was built from, they are what the tokens,
the type scale and the status language were taken out of, and they are not
regenerated from anything in this repository. Nothing reads them at build time
and no test asserts against them.

They are also, in three places, a picture of a board this application no longer
draws. Rather than hand-edit an export — which produces a file that matches
neither the design tool it came from nor the product it describes, and that
nobody can reproduce — this note says which parts still govern and which have
been overtaken.

## Still current

- **`Ground Control Design System.dc.html`** — the tokens, the neutral ramp, the
  four status colours and their reservation, the accent's brand-only rule, the
  type scale, the project-identity palette (six colours, fixed order, assigned
  once, never recycled), the row anatomy and its grid, the staleness leading bar
  and its five bands, and the ball-in-court glyphs. All of it is what
  `app.css` implements.
- **Status language.** The rule that a severity is a shape *and* a word, never a
  colour alone, is the one `greyscale.spec.ts` enforces. It comes from here.
- **`Ground Control Brand.dc.html`** — the wordmark work. Untouched by any of
  this.

## Overtaken by 0.4.0

- **The board mock shows three lanes.** `Ground Control.dc.html` draws a ticket
  lane, an **Open branches** lane, and the agent session panel. The branch lane
  and the pull-request lane are gone; there is one lane, and the agent console
  ([007](../../specs/007-agent-console/spec.md)) is what fills the space they
  left.
- **The `Attention` region at the top of the mock.** It listed drift findings and
  open questions and drove the confirm-and-dispatch route into the action queue.
  Drift is gone entirely, so the region went with it. The *open questions* half
  of what it showed is a real signal that currently has nowhere to be displayed —
  it still moves the row's ball-in-court, and 007 restores the list.
- **"Drift alert — elevated row"** in the design system. The elevated-row
  treatment itself is not gone; nothing produces the condition that triggered it.
- **The DRIFTING tile.** Four tiles in the mock, three on the board.

## If you are redesigning

Read [007's spec](../../specs/007-agent-console/spec.md) before this. The board
shrank by two lanes and a region, and the layout question that opens is the
subject of that feature rather than a gap to be filled in from these files.
