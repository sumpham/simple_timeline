# Roadmap and limits

## Not built

| Item | Why it is not trivial | Where to start |
|---|---|---|
| Cross-project links | A replan would have to cascade to other projects, with loops possible across them; the impact preview would span projects | `server/plan.ts` `loadState` / `replan`; treat an outside predecessor as a floor on the successor |
| Resource levelling | Must suggest, preview and undo, never move tasks silently | A preview-only pass over `scheduleProject` output |
| Start-to-finish links | Rarely used; MSPDI import turns them into FS today | `earliestStart` and the backward pass in `shared/schedule.ts` |
| More than one baseline | Needs a baseline id and a picker | `task_baseline` gains `baseline_id` |
| Many rows (hundreds) | Every row and bar is in the DOM | Window the table rows and the chart together, since the chart draws from measured rows |
| Grouping by environment, person or status | Conflicts with outline numbering in the table | Group in the chart only, or a separate view |
| Progress line through the status date | Needs a status date | Draw from each task's progress |

## Known limits

- The Network tab draws every link one way, whatever its type, and leaves summaries out.
- Indenting a task under a task with work discards that task's own length and environment (it
  becomes a summary). This matches MS Project, but is easy to miss.
- The portfolio's bars are grey, not in environment colours, and it is read-only.
- The Environments strip uses the board's data for a window around the plan (60 days before
  its start to 180 after its finish or target).
- Import appends; it has no Undo. Delete the imported rows by hand if needed.
- Print prints what is on screen: the divider's width and the current zoom.
- The demo seed has no summary tasks, SS/FF links or baseline. Add them by hand to see those
  features.
- `README.md` still quotes an old unit test count.
