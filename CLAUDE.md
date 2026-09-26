# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

A booking board for delivery environments. Teams own environments (SIT, UAT, PROD, …);
projects book them for date ranges; the board surfaces **double-bookings** — stretches where
more projects hold an environment than its capacity allows. That detection is the product;
everything else supports it.

`reqs.md` holds the requirements and the answered scoping questions.
`DESIGN.md` holds the architecture and UI design, including why things look the way they do.

## Commands

```bash
npm run dev        # API (5174) + Vite (5173)
npm start          # single process, serves dist/ + API on 5173
npm run build      # bundle client to dist/
npm run seed       # reset data/timeline.db to demo data
npm test           # vitest
npm run typecheck  # tsc --noEmit
```

Node 24+ required. No native modules: SQLite is `node:sqlite`, and the server's TypeScript
runs through Node's built-in type stripping rather than a build step.

## Layout

```
shared/   dates.ts, conflicts.ts, types.ts — pure, imported by BOTH server and client
server/   Express routes over SQLite; schema.sql is the source of truth for the data model
client/   React board; layout.ts holds the time scale and lane packing (pure, tested)
tests/    Vitest over shared/ and client/layout + client/components/Board's pure exports
```

## Rules that matter here

**Dates are `YYYY-MM-DD` strings, never `Date` objects, at every boundary.** All arithmetic
lives in `shared/dates.ts` and works in UTC. A plan date is a label on a calendar, not an
instant; parsing as local time makes releases appear to shift by timezone.

**Effort and occupancy are deliberately different, and conflating them breaks conflict
detection.** Effort counts working days (weekends and holidays skipped) and drives durations
and date snapping. Occupancy counts calendar days, because a Friday-to-Monday booking holds
the environment through the weekend. `detectConflicts` must stay on calendar days.

**Conflict logic belongs in `shared/conflicts.ts` only.** Both sides import it so that a
future drag preview and the server agree by construction. Do not reimplement overlap checks
in a component or a route.

**Colour is spent on one thing.** `--alarm` is for double-bookings and nothing else;
environment hues deliberately avoid the red family so the alarm stays pre-attentive. Before
adding a new coloured element, check `DESIGN.md` §6 and §11. The one addition is
`--resolved` (pale green), for a double-booking someone has accepted.

**Resolved double-bookings still exist; they just stop alarming.** A resolution is keyed by
`conflictKey` (environment + exact booking ids, no dates), stored in `conflict_resolution`,
and stamped on by `applyResolutions` on both sides. `/api/board` returns the keys as
`resolved` because the drag preview recomputes conflicts and must re-stamp them. Counts, the
red outline, rail markers and lane status all use `openConflicts`; the hatch and drawer show
every conflict, resolved ones in green.

**A one-day booking is a CUSTOM event** (`effectiveKind` in `shared/bookings.ts`), so it can
carry a marker icon. RELEASE keeps its kind. The server applies it on every write and
`server/db.ts` migrates older rows on start; the dialog and the long-press plan apply it too,
so what the form shows is what gets saved.

**Conflicts are computed over the team's whole environment set, not the filtered subset.**
Hiding a lane must not make its double-bookings disappear (see `/api/board`).

## Drag-to-edit

Three files: `client/dragMath.ts` (pure span math, tested), `client/useBookingDrag.ts`
(pointer gesture), and `pendingSpans` in `App.tsx` (optimistic overlay).

**Moving preserves working-day length, not calendar length.** Dragging a five-working-day
booking across a weekend must not make it seven. Resizing clamps instead of inverting.

**Every drag result lands on working days at both ends.** That makes the server's `snapRange`
a no-op, so the preview and the saved value agree and nothing jumps on drop. If you change
snapping on either side, change it on both.

**The live preview must flow through `pendingSpans`.** The board, the conflict engine and the
drawer all read through it. An early version fed only the readout from the drag session, so
the bar moved but conflict detection did not run until after the save — the feature's whole
point, silently missing.

**Click versus drag is decided in the hook** (4px slop), never by a click handler. The bar's
`onClick` only fires for keyboard activation, detected with `event.detail === 0`.

**Long-press to book** on empty lane space books from the pressed working day to that
week's Friday (`quickSpan` in `dragMath.ts`). It is a long press, not a click, on purpose: a
click was too easy to make by accident, and with nothing on screen during the save it looked
like it had failed. The row (`BoardRow`) runs the gesture: a ghost fills in over
`LONG_PRESS_MS`, releasing then calls `createFromPlan`; moving past the slop, Escape or a
`pointercancel` abandons it, and a plain click only shows a hint toast. `planAt` in `App.tsx`
picks the booking: the lane supplies environment or project, the last-used one the other.

**The save must never look like nothing.** From release until the server answers, a
placeholder (`provisionalBooking`, id `PROVISIONAL_ID`) is injected into `preview`, so it
packs into its real lane and runs through `detectConflicts` like any bar. It is dropped once
the refreshed board contains the created id. Every such booking gets a 6s Undo toast.

Arrow keys mirror the gestures and debounce into one write. Do not drop the keyboard path:
drag-only editing would break the accessibility requirement in `DESIGN.md` §5.

## Loops that build the ruler must be bounded

A frozen tab in this app has one likely cause: a `while` in `client/layout.ts` that fails to
advance. `majorTicks` once stepped a quarter forward by one month and then re-aligned to the
quarter start, which snapped back to where it began and spun forever — Quarter view froze
every time.

Step each period by its own length (`addMonths(period, 3)` for quarters), never by a smaller
unit followed by re-alignment. Every such loop carries a `guard` counter so a future mistake
shows up as a short ruler instead of a hung browser. `addWorkingDays` and `snapToWorkingDay`
are bounded for the same reason.

Tests cover all three zooms, including a sweep over every start date in a year. When touching
the ruler or the date walk, never test only `month`.

## Packing for another machine

`npm run pack` (`scripts/pack.mjs`) builds here and produces a zip that runs on a
target Mac with only Node 24+ — no build, no install, no internet.

Two traps it exists to avoid, both of which bit during development:

**Never copy `data/timeline.db` with `cp`.** SQLite runs in WAL mode, so recent writes
sit in `timeline.db-wal`; the main file can be hours stale. In testing a plain copy
shipped week-old seed data instead of the user's real work. The script uses
`VACUUM INTO`, which writes one consistent file.

**Vendored font URLs are same-directory.** `fonts.css` is written into `dist/fonts/`
alongside the woff2 files, so `src: url(<file>.woff2)` — not `url(fonts/<file>.woff2)`,
which resolves to `/fonts/fonts/…`.

Related: the static handler in `server/index.ts` only falls back to `index.html` for
paths with no file extension. Without that, a missing asset returns HTML with a 200
and a broken path is invisible — exactly how the font bug hid.

## Testing the UI

The Chrome extension may not be connected. Headless Chrome over the DevTools protocol works
and is better for measuring: launch with `--remote-debugging-port`, drive `Runtime.evaluate`
and `Page.captureScreenshot` over a WebSocket. Measure geometry from the DOM rather than
eyeballing screenshots — a `--screenshot` capture can differ from the emulated layout width
and produce false clipping.

## Editing

Teams, projects, environments and bookings all have full create/edit/delete, through three
manager dialogs of identical shape (`client/components/Dialogs.tsx`) plus the booking dialog.
Rail row labels open the editor for the row they name.

Destructive actions use `DangerButton`, which arms on the first click, states the cascade
using server-supplied counts (`team.project_count`, `project.booking_count`, …) and disarms
itself after 4s. Do not replace it with `confirm()` — a blocking dialog freezes the page and
breaks browser automation.

Deleting a team needs `removeTeam` in `App.tsx`, not the generic `run()` helper: the board
has to be repointed before a refresh, or it queries a team that no longer exists.

A project with zero bookings still gets a board row in project mode. Without that, a newly
added project is invisible and unreachable. A project whose bookings are merely filtered out
is correctly hidden — see `buildRows`.

## Still to build

Drag-to-edit, sub-project roll-ups, conflict acknowledgement, saved views, bulk shift,
dependency arrows, export. `DESIGN.md` §12 has the order.
