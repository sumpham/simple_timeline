# Design — simple timeline

Solution and UI design for the MVP. Derived from `reqs.md` §10 answers.

## 1. Decisions locked from your answers

| # | Answer | Consequence for the build |
|---|---|---|
| 1 | No auth | No users table, no sessions. `audit_log.actor` kept but fixed to `"local"`. Cuts ~⅓ of scope. |
| 2 | One env set per team, shared by that team's projects | Environments are team-scoped. `capacity` stays, defaults to `1`. Conflict detection partitions by team — never a cross-team query. |
| 3 | No cross-team sharing | `environment.shared` flag dropped from MVP schema. |
| 4 | No import | Editing UI is the only way data arrives, so it must be fast. Inline editing prioritized over forms. |
| 5 | One nesting level | `project.parent_id` nullable, depth capped at 1 and enforced in the API. |
| 6 | Skip weekends/holidays | See §1.1 — this splits in two. |

### 1.1 Working days: effort vs. occupancy

These are different and conflating them produces wrong conflict results.

- **Effort = working days.** Durations, the "10 working days" label, drag/resize snapping, and
  bulk shift all skip weekends and holidays. A booking can't start or end on a non-working day.
- **Occupancy = calendar days.** A booking Fri→Mon holds the environment through the weekend.
  Overlap detection therefore runs on the raw calendar interval.

Weekends and holidays are shaded in the grid, so the rule is visible rather than a hidden surprise.
A `holiday(date, name)` table seeds the calendar; empty is fine, weekends still apply.

## 2. Architecture

```
React + TS (Vite)                Express + node:sqlite               SQLite
┌──────────────────┐   fetch     ┌──────────────────────┐            ┌────────┐
│  Board renderer  │ ──────────► │  /api/*              │ ─────────► │ .db    │
│  Conflict panel  │ ◄────────── │  conflict engine     │ ◄───────── │ file   │
└──────────────────┘   JSON      └──────────────────────┘            └────────┘
         │                                  │
         └──── shared/conflicts.ts ─────────┘   one pure module, both sides
```

**Stack**: Vite + React 18 + TypeScript; Express over `node:sqlite`; plain CSS with custom
properties. No component library and no Tailwind — the board is computed positioning, and a
component kit would fight the bespoke layout rather than help it.

The plan said `better-sqlite3`, but the machine runs Node 25, which ships SQLite in core and
strips TypeScript natively. Both dependencies went away: no native build, and no compile step
for the server. `DatabaseSync` is synchronous, which suits a single-user local tool — no
connection pool, no async ceremony.

**Why a server at all** given single-user/no-auth: durable data outside the browser profile, and
the read-only share link in V2 needs an origin to serve from.

**Dates**: date-only ISO strings (`YYYY-MM-DD`) at every boundary. No `Date` objects cross the API.
This kills the timezone off-by-one from `reqs.md` §5 at the type level rather than by convention.

**Rendering**: absolutely-positioned DOM bars — deliberately *not* canvas. Canvas would render
3,000 bars more cheaply but destroys keyboard focus and screen-reader access, which §5 requires.
Bars are clipped to the visible date window by the server's `from`/`to`. Row virtualization was
specced but not built: rows are bounded by the mandatory team filter (≤10 environments, ≤30
projects), so there is nothing yet to virtualize. Revisit if the team filter ever becomes optional.

**Conflict engine**: sweep line per environment over committed bookings sorted by start date;
maintain an active set; emit a conflict interval whenever `|active| > capacity`. O(n log n).
Lives in `shared/` so the server computes it and, in V2, drag previews recompute it client-side
from the identical code.

## 3. Data model (MVP)

```sql
team(id, name, code, active, created_at)
environment(id, team_id, name, kind, capacity DEFAULT 1, sort_order)
project(id, team_id, parent_id, name, status, priority, owner, description, external_link)
booking(id, project_id, environment_id, kind, start_date, end_date, confidence, optional, note, marker)
holiday(date PRIMARY KEY, name)
audit_log(id, entity, entity_id, field, old_value, new_value, actor, at)

CREATE INDEX idx_booking_env_range ON booking(environment_id, start_date, end_date);
```

`phase` is renamed **`booking`** throughout, code and UI alike. The thing a project does to an
environment is reserve it, and naming it so makes the whole feature explain itself.

Any booking may carry a free-text `note`, shown in the bar's tooltip and edited in the booking
dialog. A `CUSTOM` booking may also carry a `marker` (`star`, `flag` or `pin`), drawn at the
start of its bar, or in place of the diamond when it is a single day. The marker takes the
environment hue, like the diamond, so `--alarm` stays the only red. The API clears `marker` for
any other kind. Databases created before these columns are backfilled by `server/db.ts`.

Dropped from the sketch for MVP: `conflict_ack` (V2), `environment.shared` (answer 3),
`project.tags` (no use yet).

## 4. API

```
GET    /api/bootstrap                     teams + environments + holidays, one call on load
GET    /api/board?team=&envs=&from=&to=   render-ready rows and bars
GET    /api/conflicts?team=&from=&to=     detected double-bookings
POST   /api/teams                         creates team + seeds SIT, UAT, PROD
PATCH  /api/teams/:id                     DELETE /api/teams/:id
POST   /api/environments                  PATCH /api/environments/:id   DELETE /api/environments/:id
POST   /api/projects                      PATCH /api/projects/:id       DELETE /api/projects/:id
POST   /api/bookings                      PATCH /api/bookings/:id       DELETE /api/bookings/:id
```

`/api/board` returns rows already grouped and bars already positioned in date space, so the
client never joins entities during interaction.

---

# UI design

## 5. Grounding

This is not a generic project dashboard. The thing being modeled is **a resource booking board** —
the vernacular of hotel room charts, studio schedules, and operating-theatre rosters. A project
*books* an environment; two projects wanting SIT at once is a *double-booking*. That metaphor
drives every visual decision below, and it drives the copy: the UI says "books" and
"double-booking", never "phase" or "conflict entity".

**Audience**: a technical lead scanning for trouble, not a stakeholder being impressed.
**Primary job**: make a double-booking impossible to miss, and everything else quiet.

## 6. Tokens

### Color

The board is a ruled instrument on drafting paper. The only saturated, alarming color in the
entire interface is a double-booking — that is where all the boldness is spent.

| Token | Hex | Role |
|---|---|---|
| `--paper` | `#EDF1F4` | app ground, cool drafting paper |
| `--lane` | `#FFFFFF` | row surface |
| `--ink` | `#16202B` | primary text, heavy rules |
| `--rule` | `#C7D1DA` | hairlines, grid |
| `--muted` | `#59677A` | secondary text, ruler labels |
| `--alarm` | `#D3232F` | double-bookings only — used nowhere else |

Environment kinds carry their own hue, deliberately avoiding the red family so `--alarm` stays
unique on screen:

`SIT #2E8C8C` · `UAT #3A62C4` · `NFT #B5731A` · `PENTEST #7A4BAE` · `PROD #1F7A45`

Dark theme swaps `--paper`/`--lane` to `#151B21`/`#1D252D` and lifts the kind hues ~12% lightness;
`--alarm` becomes `#FF5A63` to hold contrast on dark. Every token is defined on bare `:root` first.

### Type

**Archivo** and **Archivo Narrow** — one family, two widths. A grotesque built for dense
functional settings, with real tabular figures. The width contrast does work rather than
decorate: Narrow handles the date ruler and lane labels where horizontal space is scarce,
regular handles everything else.

All figures set with `font-feature-settings: "tnum" 1` so dates and day counts align in columns.
Explicitly no monospace face for data labels — a grotesque with tabular figures reads better on a
board and mono-for-small-labels is a tell.

```
Board title      Archivo 600, 19px, -0.01em
Lane label       Archivo 500, 13px
Project name     Archivo 500, 14px
Date ruler       Archivo Narrow 500, 12px, --muted
Bar label        Archivo Narrow 600, 11px
Day counts       Archivo 400, 12px, tnum
```

Sentence case everywhere. No tracked-out caps eyebrows.

## 7. Layout

Two modes over one renderer. Mode is the primary control, top-left of the board.

**By environment** (default — the conflict view). Rows are environments; every project competing
for that environment stacks into sub-lanes inside the row. Overlaps are literally stacked on top
of each other, which is the whole point.

**By project** (the planning view). Rows are projects; bars are that project's bookings.

```
┌───────────────────────────────────────────────────────────────────────────┐
│  simple timeline     Platform ▾            Week  ⟨Month⟩  Quarter          │
├───────────────────────────────────────────────────────────────────────────┤
│  TODAY   SIT  Payments R2, ends in 4d     UAT  free     PROD  Core 4.1     │ ← occupancy strip
│          next  Billing, Mar 3             next  Payments R2, Mar 10        │
├──────────────┬────────────────────────────────────────────────────────────┤
│ By environment│  February      March          April           May          │ ← ruler, sticky
│ By project    │ ░░  ░░  ░░  ░░│░░  ░░  ░░  ░░ │░░  ░░  ░░  ░░ │           │ ← weekend shading
├──────────────┼────────────────────────────────────────────────────────────┤
│ SIT       2/1 │   ▬▬▬▬ Payments R2 ▬▬▬▬                                    │
│               │              ▬▬▬▬▬ Billing ▬▬▬▬▬                           │
│               │              ╳╳╳╳╳  ← double-booked, 5 days                │
├──────────────┼────────────────────────────────────────────────────────────┤
│ UAT       0/1 │                    ▬▬▬▬▬▬▬ Payments R2 ▬▬▬▬               │
├──────────────┼────────────────────────────────────────────────────────────┤
│ PROD      1/1 │                              ◆ Core 4.1                    │
└──────────────┴────────────────────────────────────────────────────────────┘
   ▲ lane label carries live occupancy: booked / capacity
```

Left rail is sticky and left-aligned; the time grid scrolls horizontally. Day counts and dates
are right-aligned on their tabular figures. Release dates render as diamonds (`◆`), not bars,
since they are moments rather than spans.

**Structure that encodes information, not decoration:**
- Weekend and holiday columns are shaded — the working-days rule made visible.
- Lane label shows `booked/capacity` live, so an over-capacity lane announces itself in text
  before you even look at the bars.
- A lane over capacity gets a heavy `--alarm` rule down its left edge for exactly the
  conflicting date span — the rule weight itself is the signal.
- No numbered markers anywhere; the content is a timeline, and the date ruler already sequences it.

## 8. How a double-booking looks

Three redundant signals, never color alone (§5 accessibility):

1. **In the lane** — the overlapping span fills with a `--alarm` diagonal hatch across the
   stacked bars, plus a `╳` glyph at its center and the day count ("5 days").
2. **In the rail** — the lane's occupancy reads `2/1` in `--alarm`.
3. **In the panel** — a right-hand drawer lists every double-booking, sorted by severity
   (overlap days × highest priority involved), each naming the environment, the date span, and
   both projects. Clicking one scrolls the board to it.

A toolbar count sits next to the mode switch: "3 double-bookings". At zero it reads
"No double-bookings" in `--muted` — a calm board is the success state and should look like one.

## 9. Motion

One orchestrated moment: on first paint, bars draw in left-to-right in date order over ~400ms, so
the eye reads the board as time. Conflict hatching fades in once, 200ms after the bars settle, so
it arrives as a verdict on a board you've already seen. Nothing else animates unless you act on it.
Opening the drawer and confirming an edit get motion because they show what changed.
All of it behind `prefers-reduced-motion`.

## 10. Copy

Plain, active, consistent. The button that says "Book environment" produces a toast that says
"Booked".

- Empty board: "No projects yet. Add one to start booking environments." + **Add project**
- Empty conflict panel: "No double-bookings in this range."
- Validation: "SIT is booked by Billing until Mar 14." — states the fact and names who, rather
  than apologizing or saying "invalid date range".
- Non-working day: "Bookings start and end on working days. Nearest is Mon, Mar 3."

## 11. Design review against the brief

Four things in my first pass were defaults rather than choices, and I changed them:

1. **A KPI tile row** ("3 conflicts" as a big number) → replaced with the **occupancy strip**.
   The count is a vanity metric; "who holds SIT today, and who's next" is the question the QA
   and lead personas actually open the tool with, and it's the characteristic moment of a
   booking board.
2. **Team-as-bar-color**, carried over from `reqs.md` §4.1 → removed. With both environment kind
   and team driving hue, the board becomes a rainbow and the red stops being the loudest thing.
   Environment kind owns color; team is expressed through grouping and a small ink code chip.
   This is the one accessory removed.
3. **Monospace for dates and counts** → Archivo with tabular figures. Better on a dense board,
   and mono-for-small-data-labels is a generated-page tell.
4. **Cream ground, serif display, warm clay accent** → cool drafting paper, one grotesque in two
   widths, signal red reserved for alarm. The warm-paper-and-serif look belongs to editorial
   work, not an instrument you scan for trouble.

## 12. MVP build order

1. Scaffold, SQLite schema, migrations, seed demo data (3 teams, ~12 projects, deliberate overlaps)
2. `shared/dates.ts` (working days, holidays) + `shared/conflicts.ts` (sweep line) + unit tests
3. API routes
4. Board renderer: ruler, weekend shading, today line, bars, both grouping modes, zoom
5. Conflict hatching, occupancy strip, conflict drawer
6. Editing: teams, environments, projects, bookings
7. Responsive pass, keyboard nav, reduced motion, dark theme

**In MVP**: swimlane/environment mode, promoted from V2 per §1 above.
**Built since**: full CRUD (§13), drag-to-edit (§14).
**Still open**: sub-project roll-ups, conflict acknowledgement, saved views, bulk shift,
dependency arrows, export.

## 13. Built beyond the original MVP list

Full CRUD on every entity, added after the first pass exposed three gaps: teams had no edit
or delete UI at all, projects could not be edited or removed once created, and a project with
no bookings was invisible on the board and therefore unreachable.

- Three manager dialogs of one shape — list, inline edit, add row — for teams, projects and
  environments. Bookings keep their own dialog, since they carry date logic.
- Rail row labels open the editor for the row they name.
- `DangerButton`: destructive actions arm on first click and state their cascade from
  server-supplied counts, then disarm after 4s. Chosen over `confirm()` (blocks the page) and
  over a stacked dialog (loses the context you are deleting from).
- Unarmed delete buttons are deliberately **not** red. `--alarm` means double-booking; a row
  of red Remove buttons would dilute it. The colour arrives with the armed state, at the
  moment the danger is real — an extension of the §6 rule, not an exception to it.

## 14. Drag-to-edit

The reason `shared/conflicts.ts` was put in `shared/` in the first place: the drag preview
and the server now run the identical sweep line, so what the board predicts under the
pointer is what the save produces.

**Date math** lives in `client/dragMath.ts`, pure and tested apart from the pointer code.
Moving preserves the **working-day** length rather than the calendar length — dragging a
five-working-day booking across a weekend must not quietly make it seven. Resizing moves
one edge and clamps rather than inverting. Every result lands on working days at both
ends, which makes the server's own snap a no-op, so nothing jumps on drop.

**Click versus drag** is decided in `useBookingDrag`, not by a click handler racing the
gesture: a release within 4px opens the booking, anything further commits. Keyboard
activation bypasses that entirely — the bar's `onClick` fires only when `event.detail === 0`,
which only a keyboard produces.

**Optimistic preview.** `pendingSpans` in `App` holds provisional dates by booking id. The
board, the conflict engine and the drawer all read through it, so a collision appears while
you are still holding the bar. It survives until the refresh lands, so the bar never snaps
back for a frame, and is dropped on failure to restore the saved dates.

**Keyboard parity.** Arrows move, shift/alt take an edge. Presses are debounced into a single
write. Without this, drag-only editing would have made the board's own accessibility
requirement (§5) a dead letter.

**The readout** states the outcome rather than decorating the gesture: new dates,
working-day length, and a red `double-booked` badge when the drop would clash.
