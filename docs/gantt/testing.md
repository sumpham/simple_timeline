# Testing

## Unit tests

`npm test` (vitest). 202 tests at the time of writing. The chart work is covered by:

| File | Covers |
|---|---|
| `tests/gantt.test.ts` | Scale, weekday columns, header bands and grid lines at every zoom, Fit, drag landing (holidays, clamping), start/finish fields, variance, progress, chain tracing, row visibility, `occupancyByDay`, link paths for FS/SS/FF |
| `tests/schedule.test.ts` | SS and FF in both passes, untyped links as FS, summary roll-up, links to and from summaries |
| `tests/wbs.test.ts` | Outline numbering, loops, indent, outdent, moving a summary with its tasks, leaves |
| `tests/planIO.test.ts` | CSV parsing and round trip, loose headers and WBS, errors; MSPDI round trip, summary row, outline levels, SF |
| `tests/predecessors.test.ts` | The After notation with SS/FF |

Server routes have no unit tests; exercise them against a scratch database (below).

## Checking the UI

The Chrome extension may not be connected. Headless Chrome over the DevTools protocol works,
and measuring the DOM beats eyeballing screenshots.

```bash
S=/path/to/scratch
TIMELINE_DB=$S/t.db npm run seed                       # never touch data/timeline.db
npm run build
TIMELINE_DB=$S/t.db PORT=5199 node server/index.ts &
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \
  --remote-debugging-port=9333 --user-data-dir=$S/chrome about:blank &
```

Then drive it over the WebSocket from `http://127.0.0.1:9333/json`: `Page.navigate`,
`Runtime.evaluate`, `Input.dispatchMouseEvent` (pointer events follow from mouse events, and
`setPointerCapture` works), `Input.dispatchKeyEvent` (`modifiers`: 1 Alt, 8 Shift),
`DOM.setFileInputFiles` for import, `Emulation.setEmulatedMedia {media:'print'}` for print,
`Page.captureScreenshot`.

What was checked this way:

- rows and bars line up (row middles within 1px);
- drag shows the readout and names a new double-booking before the drop; the drop saves and
  shows the impact banner;
- resize via the grip, linking via the dot, the link editor, Alt+arrows;
- all three zoom steps, dark mode, phone width (no horizontal page scroll), print media;
- CSV import through the real file input;
- Network tab with a summary present; Portfolio.

## Traps met along the way

| Trap | Avoid by |
|---|---|
| `Page.navigate` to the same URL with only a hash change does not reload | Navigate to `about:blank` first |
| `location.reload()` inside `Runtime.evaluate` kills the evaluation | Reload in one call, measure in the next |
| In zsh, `curl $FLAGS` does not split `$FLAGS` | Write a small Node script with `fetch` |
| The first link found may sit under the pinned table | Check `document.elementFromPoint` before clicking |
| `width: max(884px, 100%)` on a table in a shrink-to-fit wrapper resolved to 1,000,000px | Only fill the width once the divider has set one (`.is-sized`) |
| A remembered divider width beat the phone layout's width rule | The phone rule names `.task-split-table.is-sized .task-table` too |
| Sticky headers stop sticking inside an `overflow: hidden` wrapper | Use `overflow-x: clip` |
