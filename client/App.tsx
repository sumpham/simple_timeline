import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type BoardData, type Bootstrap } from './api.ts';
import { addWorkingDays, snapToWorkingDay, today as todayISO } from '../shared/dates.ts';
import type { BookingView, Conflict, Environment, ISODate } from '../shared/types.ts';
import { makeScale, ZOOM, type Zoom } from './layout.ts';
import { Board, buildRows, DragReadout, ENV_COLOR, rowHeights, type Mode } from './components/Board.tsx';
import { useBookingDrag } from './useBookingDrag.ts';
import { applyDrag, withSpan, type DragMode, type Span } from './dragMath.ts';
import { detectConflicts } from '../shared/conflicts.ts';
import { OccupancyStrip } from './components/OccupancyStrip.tsx';
import { ConflictDrawer } from './components/ConflictDrawer.tsx';
import {
  BookingDialog, EnvironmentDialog, ProjectsDialog, TeamsDialog, type BookingDraft,
} from './components/Dialogs.tsx';

type DialogState =
  | { kind: 'none' }
  | { kind: 'booking'; draft: BookingDraft; existing?: BookingView }
  | { kind: 'projects'; editingId?: number }
  | { kind: 'environments' }
  | { kind: 'teams' };

export function App() {
  const today = useMemo(() => todayISO(), []);

  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [teamId, setTeamId] = useState<number | null>(null);
  const [zoom, setZoom] = useState<Zoom>('month');
  const [mode, setMode] = useState<Mode>('environment');
  const [hiddenEnvs, setHiddenEnvs] = useState<Set<number>>(new Set());
  const [data, setData] = useState<BoardData | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(true);
  const [dialog, setDialog] = useState<DialogState>({ kind: 'none' });
  const [error, setError] = useState<string | null>(null);
  const [dialogError, setDialogError] = useState<string | undefined>();
  const [animate, setAnimate] = useState(true);
  /** Optimistic date overrides, by booking id, while an edit is in flight. */
  const [pendingSpans, setPendingSpans] = useState<Map<number, Span>>(new Map());

  const railRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null!);

  const scale = useMemo(() => makeScale(zoom, today), [zoom, today]);
  const holidaySet = useMemo(
    () => new Set((boot?.holidays ?? []).map((h) => h.date)),
    [boot?.holidays],
  );

  const load = useCallback(async () => {
    try {
      const b = boot ?? (await api.bootstrap());
      if (!boot) setBoot(b);

      const team = teamId ?? b.teams[0]?.id ?? null;
      if (team !== teamId) setTeamId(team);
      if (team == null) { setData(null); return; }

      setData(await api.board({ team, from: scale.from, to: scale.to }));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the board');
    }
  }, [boot, teamId, scale.from, scale.to]);

  useEffect(() => { void load(); }, [load]);

  // The entrance plays once on load, not on every filter change.
  useEffect(() => {
    const t = setTimeout(() => setAnimate(false), 900);
    return () => clearTimeout(t);
  }, []);

  const refresh = useCallback(async () => {
    if (teamId == null) return;
    try {
      const [b, board] = await Promise.all([
        api.bootstrap(),
        api.board({ team: teamId, from: scale.from, to: scale.to }),
      ]);
      setBoot(b);
      setData(board);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not refresh the board');
    }
  }, [teamId, scale.from, scale.to]);

  const environments = data?.environments ?? [];
  const visibleEnvIds = useMemo(
    () => new Set(environments.filter((e) => !hiddenEnvs.has(e.id)).map((e) => e.id)),
    [environments, hiddenEnvs],
  );

  /**
   * While a bar is being dragged the board shows where it would land, not where
   * it still is. Conflicts are recomputed from that same provisional set using
   * the shared engine, so a collision you are about to create appears under the
   * pointer rather than after the save.
   */
  const preview = useMemo(() => {
    if (!data) return null;
    if (!pendingSpans.size) return { bookings: data.bookings, conflicts: data.conflicts };

    const bookings = data.bookings.map((b) => {
      const span = pendingSpans.get(b.id);
      return span ? withSpan(b, span, holidaySet) : b;
    });
    return { bookings, conflicts: detectConflicts(bookings) };
  }, [data, pendingSpans, holidaySet]);

  const conflicts = preview?.conflicts ?? [];

  const boardData = useMemo(
    () => (data && preview ? { ...data, bookings: preview.bookings, conflicts: preview.conflicts } : null),
    [data, preview],
  );

  const rows = useMemo(
    () => (boardData ? buildRows(mode, boardData, visibleEnvIds, today) : []),
    [boardData, mode, visibleEnvIds, today],
  );
  const heights = useMemo(() => rowHeights(rows, scale.dayWidth), [rows, scale.dayWidth]);

  // The rail and the grid scroll as one surface.
  const syncRail = useCallback((scrollTop: number) => {
    const el = railRef.current;
    if (el?.firstElementChild instanceof HTMLElement) {
      el.firstElementChild.style.transform = `translateY(${-scrollTop}px)`;
    }
  }, []);

  const scrollTo = useCallback((date: ISODate) => {
    const el = gridRef.current;
    if (!el) return;
    el.scrollTo({ left: Math.max(0, scale.x(date) - el.clientWidth / 3), behavior: 'smooth' });
  }, [scale]);

  // Open on today rather than on the start of the window.
  useEffect(() => {
    if (data) scrollTo(today);
  }, [data, zoom, scrollTo, today]);

  const openBooking = useCallback((b: BookingView) => {
    setDialog({
      kind: 'booking',
      existing: b,
      draft: {
        id: b.id,
        project_id: b.project_id,
        environment_id: b.environment_id,
        kind: b.kind,
        start_date: b.start_date,
        end_date: b.end_date,
        confidence: b.confidence,
        optional: !!b.optional,
      },
    });
  }, []);

  const closeDialog = useCallback(() => {
    setDialog({ kind: 'none' });
    setDialogError(undefined);
  }, []);

  const switchTeam = useCallback((id: number | null) => {
    setTeamId(id);
    setHiddenEnvs(new Set());
    setData(null);
  }, []);

  /** Run a mutation, refresh, and report failure inside the dialog that caused it. */
  const run = async (fn: () => Promise<unknown>, alsoClose = true) => {
    try {
      setDialogError(undefined);
      await fn();
      await refresh();
      if (alsoClose) setDialog({ kind: 'none' });
    } catch (err) {
      setDialogError(err instanceof Error ? err.message : 'That did not work');
    }
  };

  /**
   * Teams need their own handlers: after adding or removing one, the board may have
   * to point somewhere else, and `refresh` would otherwise query a team that is gone.
   */
  const addTeam = async (t: { name: string; code: string }) => {
    try {
      setDialogError(undefined);
      const created = await api.createTeam(t);
      setBoot(await api.bootstrap());
      switchTeam(created.id);
    } catch (err) {
      setDialogError(err instanceof Error ? err.message : 'Could not add that team');
    }
  };

  const removeTeam = async (id: number) => {
    try {
      setDialogError(undefined);
      await api.deleteTeam(id);
      const b = await api.bootstrap();
      setBoot(b);
      if (id === teamId) switchTeam(b.teams[0]?.id ?? null);
      else await refresh();
    } catch (err) {
      setDialogError(err instanceof Error ? err.message : 'Could not remove that team');
    }
  };

  const setPending = useCallback((id: number, span: Span | null) => {
    setPendingSpans((prev) => {
      const next = new Map(prev);
      if (span) next.set(id, span);
      else next.delete(id);
      return next;
    });
  }, []);

  /**
   * Write new dates, keeping the optimistic span on screen until the refresh
   * lands so the bar does not snap back to its old place and then forward again.
   * On failure the override is dropped, which restores the saved dates.
   */
  const commitSpan = useCallback(async (booking: BookingView, span: Span) => {
    setPending(booking.id, span);
    try {
      await api.updateBooking(booking.id, { start_date: span.start, end_date: span.end });
      await refresh();
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not move that booking');
    } finally {
      setPending(booking.id, null);
    }
  }, [refresh, setPending]);

  const { session: drag, begin: beginDrag } = useBookingDrag({
    dayWidth: scale.dayWidth,
    holidays: holidaySet,
    onCommit: commitSpan,
    onSelect: (booking) => openBooking(booking),
    onPreview: setPending,
  });

  // Keyboard nudges arrive one key at a time; hold them on screen and write once
  // the user stops, so a run of arrow presses is a single save.
  const nudgeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nudgeBase = useRef<Map<number, BookingView>>(new Map());

  const nudge = useCallback((booking: BookingView, dragMode: DragMode, days: number) => {
    const base = nudgeBase.current.get(booking.id) ?? booking;
    nudgeBase.current.set(booking.id, base);

    const current = pendingSpans.get(booking.id);
    const from = current ? withSpan(base, current, holidaySet) : base;
    const span = applyDrag(from, dragMode, days, holidaySet);
    setPending(booking.id, span);

    if (nudgeTimer.current) clearTimeout(nudgeTimer.current);
    nudgeTimer.current = setTimeout(() => {
      nudgeBase.current.delete(booking.id);
      void commitSpan(base, span);
    }, 500);
  }, [pendingSpans, holidaySet, setPending, commitSpan]);

  const openNewBooking = (projectId?: number) => {
    if (!data?.projects.length || !environments.length) return;
    const start = snapToWorkingDay(today, new Set(boot?.holidays.map((h) => h.date)));
    setDialog({
      kind: 'booking',
      draft: {
        project_id: projectId ?? data.projects[0].id,
        environment_id: environments[0].id,
        kind: environments[0].kind === 'PROD' ? 'RELEASE' : environments[0].kind,
        start_date: start,
        end_date: addWorkingDays(start, 4),
        confidence: 'committed',
        optional: false,
      },
    });
  };

  const selectConflict = (c: Conflict) => {
    setMode('environment');
    setHiddenEnvs((prev) => {
      const next = new Set(prev);
      next.delete(c.environment_id);
      return next;
    });
    scrollTo(c.start_date);
  };

  if (!boot) {
    return <div className="empty"><p>Loading the board…</p></div>;
  }

  const team = boot.teams.find((t) => t.id === teamId) ?? null;

  return (
    <div className="app">
      <header className="topbar">
        <h1 className="wordmark"><span />simple timeline</h1>

        <label className="field">
          Team
          <select
            value={teamId ?? ''}
            onChange={(e) => switchTeam(Number(e.target.value))}
          >
            {boot.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </label>

        <div className="segmented" role="group" aria-label="Time grain">
          {(Object.keys(ZOOM) as Zoom[]).map((z) => (
            <button
              key={z}
              type="button"
              aria-pressed={zoom === z}
              onClick={() => setZoom(z)}
            >
              {ZOOM[z].label}
            </button>
          ))}
        </div>

        <span className="topbar-spacer" />

        <button type="button" className="btn quiet" onClick={() => setDialog({ kind: 'teams' })}>
          Teams
        </button>
        {team && (
          <button type="button" className="btn quiet" onClick={() => setDialog({ kind: 'projects' })}>
            Projects
          </button>
        )}
        {team && (
          <button type="button" className="btn quiet" onClick={() => setDialog({ kind: 'environments' })}>
            Environments
          </button>
        )}
        {team && data?.projects.length ? (
          <button type="button" className="btn" onClick={() => openNewBooking()}>Book environment</button>
        ) : null}

        <button
          type="button"
          className={`conflict-toggle${conflicts.length ? ' has-conflicts' : ''}`}
          aria-pressed={drawerOpen}
          onClick={() => setDrawerOpen((v) => !v)}
        >
          {conflicts.length > 0 && <span className="marker" aria-hidden="true" />}
          {conflicts.length
            ? `${conflicts.length} double-booking${conflicts.length === 1 ? '' : 's'}`
            : 'No double-bookings'}
        </button>
      </header>

      {error && <div className="error-bar">{error}</div>}

      {data && (
        <OccupancyStrip
          environments={environments.filter((e) => visibleEnvIds.has(e.id))}
          bookings={data.bookings}
          today={today}
        />
      )}

      <div className="body">
        {!team ? (
          <div className="empty">
            <h2>No teams yet</h2>
            <p>A team owns its environments and the projects that book them. Add one to start.</p>
            <div><button type="button" className="btn" onClick={() => setDialog({ kind: 'teams' })}>Add team</button></div>
          </div>
        ) : !data ? (
          <div className="empty"><p>Loading {team.name}…</p></div>
        ) : rows.length === 0 ? (
          <div className="empty">
            <h2>Nothing booked yet</h2>
            <p>
              {data.projects.length
                ? 'This team has projects but no bookings in view. Book an environment, or widen the time grain.'
                : `Add a project to ${team.name}, then book an environment for it.`}
            </p>
            <div>
              <button
                type="button"
                className="btn"
                onClick={data.projects.length ? () => openNewBooking() : () => setDialog({ kind: 'projects' })}
              >
                {data.projects.length ? 'Book environment' : 'Add project'}
              </button>
            </div>
          </div>
        ) : (
          <div className="board-wrap">
            <div className="rail">
              <div className="rail-head">
                <div className="mode-switch" role="group" aria-label="Group rows by">
                  <button type="button" aria-pressed={mode === 'environment'} onClick={() => setMode('environment')}>
                    By environment
                  </button>
                  <button type="button" aria-pressed={mode === 'project'} onClick={() => setMode('project')}>
                    By project
                  </button>
                </div>
              </div>

              <div className="rail-rows" ref={railRef}>
              <div>
              {rows.map((row, i) => (
                <div
                  key={row.key}
                  className={`rail-row${row.conflicts.length ? ' is-conflicted' : ''}`}
                  style={{ height: heights[i] }}
                >
                  <button
                    type="button"
                    className="rail-main"
                    title={mode === 'environment' ? `Edit ${row.name}` : `Edit ${row.name}`}
                    onClick={() => setDialog(mode === 'environment'
                      ? { kind: 'environments' }
                      : { kind: 'projects', editingId: row.id })}
                  >
                    <div className="rail-name">
                      {mode === 'environment' && (
                        <span className="env-dot" style={{ ['--env-color' as string]: ENV_COLOR[row.kind] }} />
                      )}
                      {row.name}
                    </div>
                    <div className="rail-meta">{row.meta}</div>
                  </button>
                  {row.occupancy && (
                    <span
                      className={`occupancy${row.occupancy.booked > row.occupancy.capacity ? ' over' : ''}`}
                      title={`${row.occupancy.booked} booked today, room for ${row.occupancy.capacity}`}
                    >
                      {row.occupancy.booked}/{row.occupancy.capacity}
                    </span>
                  )}
                </div>
              ))}
              </div>
              </div>

              <div className="rail-foot">
              <div className="filter-head">Show environments</div>
              <div className="filter-list">
                {environments.map((env) => {
                  const count = data.conflicts.filter((c) => c.environment_id === env.id).length;
                  return (
                    <label key={env.id} className="filter-item">
                      <input
                        type="checkbox"
                        checked={!hiddenEnvs.has(env.id)}
                        onChange={() => setHiddenEnvs((prev) => {
                          const next = new Set(prev);
                          if (next.has(env.id)) next.delete(env.id); else next.add(env.id);
                          return next;
                        })}
                      />
                      <span className="env-dot" style={{ ['--env-color' as string]: ENV_COLOR[env.kind] }} />
                      {env.name}
                      {count > 0 && <span className="count over">{count}</span>}
                    </label>
                  );
                })}
              </div>
              </div>
            </div>

            <Board
              rows={rows}
              scale={scale}
              holidays={boot.holidays}
              today={today}
              mode={mode}
              gridRef={gridRef}
              onScroll={syncRail}
              onSelectBooking={openBooking}
              onDragStart={beginDrag}
              onNudge={nudge}
              drag={drag}
              animate={animate}
            />
          </div>
        )}

        {drawerOpen && (
          <ConflictDrawer
            conflicts={conflicts}
            onSelect={selectConflict}
            onClose={() => setDrawerOpen(false)}
          />
        )}
      </div>

      {drag && (
        <DragReadout
          drag={drag}
          clashes={conflicts.some((c) => c.booking_ids.includes(drag.booking.id))}
        />
      )}

      {dialog.kind === 'booking' && data && (
        <BookingDialog
          draft={dialog.draft}
          projects={data.projects}
          environments={environments}
          holidays={boot.holidays.map((h) => h.date)}
          error={dialogError}
          onClose={closeDialog}
          onDelete={dialog.draft.id
            ? () => run(() => api.deleteBooking(dialog.draft.id!))
            : undefined}
          onSave={(d) => run(() => {
            const body = {
              project_id: d.project_id,
              environment_id: d.environment_id,
              kind: d.kind as BookingView['kind'],
              start_date: d.start_date,
              end_date: d.end_date,
              confidence: d.confidence as BookingView['confidence'],
              optional: d.optional ? 1 : 0,
            };
            return d.id ? api.updateBooking(d.id, body) : api.createBooking(body);
          })}
        />
      )}

      {dialog.kind === 'projects' && teamId != null && team && data && (
        <ProjectsDialog
          projects={data.projects}
          teamName={team.name}
          initialEditingId={dialog.editingId ?? null}
          error={dialogError}
          onClose={closeDialog}
          onCreate={(p) => run(() => api.createProject({ ...p, team_id: teamId }), false)}
          onUpdate={(id, p) => run(() => api.updateProject(id, p), false)}
          onDelete={(id) => run(() => api.deleteProject(id), false)}
          onBook={(projectId) => { setDialogError(undefined); openNewBooking(projectId); }}
        />
      )}

      {dialog.kind === 'environments' && teamId != null && team && (
        <EnvironmentDialog
          environments={environments}
          teamName={team.name}
          error={dialogError}
          onClose={closeDialog}
          onCreate={(e) => run(() => api.createEnvironment({ ...e, team_id: teamId } as Parameters<typeof api.createEnvironment>[0]), false)}
          onUpdate={(id, e) => run(() => api.updateEnvironment(id, e), false)}
          onDelete={(id) => run(() => api.deleteEnvironment(id), false)}
        />
      )}

      {dialog.kind === 'teams' && (
        <TeamsDialog
          teams={boot.teams}
          currentId={teamId}
          error={dialogError}
          onClose={closeDialog}
          onSelect={(id) => { switchTeam(id); setDialogError(undefined); }}
          onCreate={addTeam}
          onUpdate={(id, t) => run(() => api.updateTeam(id, t), false)}
          onDelete={removeTeam}
        />
      )}

    </div>
  );
}
