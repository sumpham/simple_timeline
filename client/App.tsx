import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type BoardData, type Bootstrap } from './api.ts';
import { addDays, addWorkingDays, snapToWorkingDay, today as todayISO } from '../shared/dates.ts';
import type { BookingView, Conflict, Environment, ISODate } from '../shared/types.ts';
import { formatRange, makeScale, ZOOM, type Zoom } from './layout.ts';
import { Board, buildRows, DragReadout, ENV_COLOR, rowHeights, type Mode, type Row } from './components/Board.tsx';
import { useBookingDrag } from './useBookingDrag.ts';
import {
  applyDrag, bookingKindFor, provisionalBooking, quickSpan, withSpan,
  type DragMode, type QuickPlan, type Span,
} from './dragMath.ts';
import { detectConflicts } from '../shared/conflicts.ts';
import { OccupancyStrip } from './components/OccupancyStrip.tsx';
import { ConflictDrawer, ConflictList } from './components/ConflictDrawer.tsx';
import { BoardSheet, BookingSheet, EnvFilter } from './components/Sheets.tsx';
import { PHONE_QUERY, useMediaQuery, usePinchZoom } from './touch.ts';
import {
  BookingDialog, EnvironmentDialog, ProjectsDialog, TeamsDialog, type BookingDraft,
} from './components/Dialogs.tsx';

type DialogState =
  | { kind: 'none' }
  | { kind: 'booking'; draft: BookingDraft; existing?: BookingView }
  | { kind: 'projects'; editingId?: number }
  | { kind: 'environments' }
  | { kind: 'teams' };

/** The phone's bottom sheets. Only one is up at a time. */
type SheetState =
  | { kind: 'none' }
  | { kind: 'conflicts' }
  | { kind: 'board' }
  | { kind: 'booking'; id: number };

/** Coarse to fine, which is the direction a spreading pinch travels. */
const ZOOM_ORDER: Zoom[] = ['quarter', 'month', 'week'];

export function App() {
  const today = useMemo(() => todayISO(), []);
  const isPhone = useMediaQuery(PHONE_QUERY);

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
  /** A dialog's mutation is in flight; the managers show it as a bar along the top. */
  const [busy, setBusy] = useState(false);
  const [animate, setAnimate] = useState(true);
  /** Optimistic date overrides, by booking id, while an edit is in flight. */
  const [pendingSpans, setPendingSpans] = useState<Map<number, Span>>(new Map());
  const [sheet, setSheet] = useState<SheetState>({ kind: 'none' });
  /** A short message at the foot of the board; with an id, it offers that booking back. */
  const [toast, setToast] = useState<{ text: string; undoId?: number } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * A long-press booking on its way to the server. `createdId` is set once the
   * server answers, and the placeholder bows out when the refreshed board has it.
   */
  const [quick, setQuick] = useState<{ plan: QuickPlan; createdId?: number } | null>(null);

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
    // A long-press booking shows as soon as the finger lifts, until the real one arrives.
    const placeholder = quick && !data.bookings.some((b) => b.id === quick.createdId)
      ? provisionalBooking(quick.plan, holidaySet)
      : null;
    if (!pendingSpans.size && !placeholder) return { bookings: data.bookings, conflicts: data.conflicts };

    const bookings = data.bookings.map((b) => {
      const span = pendingSpans.get(b.id);
      return span ? withSpan(b, span, holidaySet) : b;
    });
    if (placeholder) bookings.push(placeholder);
    return { bookings, conflicts: detectConflicts(bookings) };
  }, [data, pendingSpans, holidaySet, quick]);

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

  /** The date a pinch was centred on, and where on screen, so a zoom keeps it in place. */
  const zoomAnchor = useRef<{ date: ISODate; offset: number } | null>(null);
  const scrolledFor = useRef<string | null>(null);

  // Open on today rather than on the start of the window -- once per team and zoom.
  // Refreshes after an edit must not move the board, or every save yanks it back.
  useEffect(() => {
    const key = `${teamId}:${zoom}`;
    if (!data || scrolledFor.current === key) return;
    scrolledFor.current = key;
    const anchor = zoomAnchor.current;
    zoomAnchor.current = null;
    if (anchor && gridRef.current) {
      gridRef.current.scrollLeft = Math.max(0, scale.x(anchor.date) - anchor.offset);
    } else {
      scrollTo(today);
    }
  }, [data, zoom, teamId, scale, scrollTo, today]);

  usePinchZoom(gridRef, (step, clientX) => {
    const next = ZOOM_ORDER[ZOOM_ORDER.indexOf(zoom) + step];
    const el = gridRef.current;
    if (!next || !el) return;
    const offset = clientX - el.getBoundingClientRect().left;
    zoomAnchor.current = {
      date: addDays(scale.from, Math.floor((el.scrollLeft + offset) / scale.dayWidth)),
      offset,
    };
    setZoom(next);
  });

  /**
   * The project and environment last worked with. A click on an environment lane
   * says where but not who, and a click on a project lane says who but not where;
   * the missing half comes from here.
   */
  const lastUsed = useRef<{ project?: number; env?: number }>({});
  const remember = (projectId: number, envId: number) => {
    lastUsed.current = { project: projectId, env: envId };
  };

  const openBooking = useCallback((b: BookingView) => {
    remember(b.project_id, b.environment_id);
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
        note: b.note ?? '',
        marker: b.marker,
      },
    });
  }, []);

  const closeDialog = useCallback(() => {
    setDialog({ kind: 'none' });
    setDialogError(undefined);
  }, []);

  /** A phone opens a sheet over a live board; a desktop opens the full editor. */
  const selectBooking = useCallback((b: BookingView) => {
    if (isPhone) setSheet({ kind: 'booking', id: b.id });
    else openBooking(b);
  }, [isPhone, openBooking]);

  const switchTeam = useCallback((id: number | null) => {
    setTeamId(id);
    setHiddenEnvs(new Set());
    setData(null);
  }, []);

  /** Run a mutation, refresh, and report failure inside the dialog that caused it. */
  const run = async (fn: () => Promise<unknown>, alsoClose = true) => {
    setBusy(true);
    try {
      setDialogError(undefined);
      await fn();
      await refresh();
      if (alsoClose) setDialog({ kind: 'none' });
    } catch (err) {
      setDialogError(err instanceof Error ? err.message : 'That did not work');
    } finally {
      setBusy(false);
    }
  };

  /**
   * Teams need their own handlers: after adding or removing one, the board may have
   * to point somewhere else, and `refresh` would otherwise query a team that is gone.
   */
  const addTeam = async (t: { name: string; code: string }) => {
    setBusy(true);
    try {
      setDialogError(undefined);
      const created = await api.createTeam(t);
      setBoot(await api.bootstrap());
      switchTeam(created.id);
    } catch (err) {
      setDialogError(err instanceof Error ? err.message : 'Could not add that team');
    } finally {
      setBusy(false);
    }
  };

  const removeTeam = async (id: number) => {
    setBusy(true);
    try {
      setDialogError(undefined);
      await api.deleteTeam(id);
      const b = await api.bootstrap();
      setBoot(b);
      if (id === teamId) switchTeam(b.teams[0]?.id ?? null);
      else await refresh();
    } catch (err) {
      setDialogError(err instanceof Error ? err.message : 'Could not remove that team');
    } finally {
      setBusy(false);
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

  const { session: drag, begin: beginDrag, picked, drop } = useBookingDrag({
    dayWidth: scale.dayWidth,
    holidays: holidaySet,
    onCommit: commitSpan,
    onSelect: selectBooking,
    onPreview: setPending,
  });

  // Touching anything but a bar puts a picked-up bar back down.
  useEffect(() => {
    const el = gridRef.current;
    if (!el || picked == null) return;
    const onDown = (e: PointerEvent) => {
      if (!(e.target instanceof Element && e.target.closest('.bar'))) drop();
    };
    el.addEventListener('pointerdown', onDown);
    return () => el.removeEventListener('pointerdown', onDown);
  }, [picked, drop, data]);

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
        kind: bookingKindFor(environments[0].kind),
        start_date: start,
        end_date: addWorkingDays(start, 4),
        confidence: 'committed',
        optional: false,
        note: '',
        marker: null,
      },
    });
  };

  const showToast = (text: string, undoId?: number, ms = 6000) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ text, undoId });
    toastTimer.current = setTimeout(() => setToast(null), ms);
  };

  /**
   * A long press is still easy to make by accident, so every booking made that way
   * can be taken back for a few seconds. Undo deletes it outright, whatever was
   * done to it since.
   */
  const undoCreate = async () => {
    const id = toast?.undoId;
    if (id == null) return;
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(null);
    setSheet((s) => (s.kind === 'booking' && s.id === id ? { kind: 'none' } : s));
    setDialog((d) => (d.kind === 'booking' && d.draft.id === id ? { kind: 'none' } : d));
    try {
      await api.deleteBooking(id);
      await refresh();
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not undo that booking');
    }
  };

  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  /**
   * What a long press on this lane, at this day, would book: the lane gives the
   * environment or the project, and the last one used fills in the other. The
   * board draws it under the finger while the press is held.
   */
  const planAt = (row: Row, date: ISODate): QuickPlan | null => {
    if (!data?.projects.length || quick) return null;
    const pick = <T extends { id: number }>(list: T[], id?: number) => list.find((x) => x.id === id) ?? list[0];
    const visible = environments.filter((e) => visibleEnvIds.has(e.id));
    const project = mode === 'project'
      ? data.projects.find((p) => p.id === row.id)
      : pick(data.projects, lastUsed.current.project);
    const env = mode === 'environment'
      ? environments.find((e) => e.id === row.id)
      : pick(visible.length ? visible : environments, lastUsed.current.env);
    if (!project || !env) return null;
    return { project, env, kind: bookingKindFor(env.kind), span: quickSpan(date, holidaySet) };
  };

  /**
   * Save a long-press booking. The placeholder bar is on the board from the moment
   * the press ends, so the wait for the server reads as saving, not as nothing.
   */
  const createFromPlan = async (plan: QuickPlan) => {
    const { project, env, kind, span } = plan;
    setQuick({ plan });
    try {
      const created = await api.createBooking({
        project_id: project.id,
        environment_id: env.id,
        kind,
        start_date: span.start,
        end_date: kind === 'RELEASE' ? span.start : span.end,
        confidence: 'committed',
      });
      setQuick({ plan, createdId: created.id });
      remember(project.id, env.id);
      await refresh();
      setError(null);
      showToast(`Booked ${project.name} on ${env.name}, ${formatRange(created.start_date, created.end_date)}`, created.id);
      if (isPhone) {
        setSheet({ kind: 'booking', id: created.id });
      } else {
        // Focused, so the arrow keys adjust it at once; flashed, so the eye finds it.
        requestAnimationFrame(() => {
          const bar = gridRef.current?.querySelector<HTMLElement>(`[data-booking="${created.id}"]`);
          if (!bar) return;
          bar.focus({ preventScroll: true });
          bar.classList.add('is-fresh');
          setTimeout(() => bar.classList.remove('is-fresh'), 1400);
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create that booking');
    } finally {
      setQuick(null);
    }
  };

  const selectConflict = (c: Conflict) => {
    setMode('environment');
    setHiddenEnvs((prev) => {
      const next = new Set(prev);
      next.delete(c.environment_id);
      return next;
    });
    setSheet({ kind: 'none' });
    // Wait a frame for the mode switch and filter change to render the lane, then
    // scroll both ways in one call: a second smooth scroll would cancel the first.
    requestAnimationFrame(() => {
      const el = gridRef.current;
      const row = el?.querySelector<HTMLElement>(`[data-row="env-${c.environment_id}"]`);
      if (!el || !row) return scrollTo(c.start_date);
      el.scrollTo({
        left: Math.max(0, scale.x(c.start_date) - el.clientWidth / 3),
        top: Math.max(0, row.offsetTop - 8),
        behavior: 'smooth',
      });
      row.classList.remove('is-flashed');
      void row.offsetWidth;
      row.classList.add('is-flashed');
    });
  };

  const toggleEnv = (id: number) => setHiddenEnvs((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const editRow = (row: { id: number }) => setDialog(mode === 'environment'
    ? { kind: 'environments' }
    : { kind: 'projects', editingId: row.id });

  const conflictLabel = conflicts.length
    ? `${conflicts.length} double-booking${conflicts.length === 1 ? '' : 's'}`
    : 'No double-bookings';

  const modeSwitch = (
    <div className="mode-switch" role="group" aria-label="Group rows by">
      <button type="button" aria-pressed={mode === 'environment'} onClick={() => setMode('environment')}>
        By environment
      </button>
      <button type="button" aria-pressed={mode === 'project'} onClick={() => setMode('project')}>
        By project
      </button>
    </div>
  );

  const zoomSwitch = (
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
  );

  if (!boot) {
    return <div className="empty"><p>Loading the board…</p></div>;
  }

  const team = boot.teams.find((t) => t.id === teamId) ?? null;

  return (
    <div className="app">
      {isPhone ? (
        <header className="m-topbar">
          <button
            type="button"
            className="m-team"
            aria-haspopup="dialog"
            onClick={() => setSheet({ kind: 'board' })}
          >
            <span className="m-team-mark" aria-hidden="true" />
            <span className="m-team-name">{team?.name ?? 'Choose a team'}</span>
            <svg className="m-team-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
          </button>
          {zoomSwitch}
        </header>
      ) : (
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

        {zoomSwitch}

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
          {conflictLabel}
        </button>
      </header>
      )}

      {isPhone && team && data && rows.length > 0 && <div className="m-modebar">{modeSwitch}</div>}

      {error && <div className="error-bar">{error}</div>}

      {data && !isPhone && (
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
          <div className={`board-wrap${isPhone ? ' compact' : ''}`}>
            {!isPhone && (
            <div className="rail">
              <div className="rail-head">{modeSwitch}</div>

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
                    onClick={() => editRow(row)}
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
              <EnvFilter
                environments={environments}
                hidden={hiddenEnvs}
                conflicts={data.conflicts}
                onToggle={toggleEnv}
              />
              </div>
            </div>
            )}

            <Board
              rows={rows}
              scale={scale}
              holidays={boot.holidays}
              today={today}
              mode={mode}
              gridRef={gridRef}
              onScroll={syncRail}
              onSelectBooking={selectBooking}
              onDragStart={beginDrag}
              onNudge={nudge}
              drag={drag}
              animate={animate}
              compact={isPhone}
              picked={picked}
              onEditRow={editRow}
              planAt={data.projects.length ? planAt : undefined}
              onCreate={(plan) => void createFromPlan(plan)}
              onHint={() => showToast('Press and hold on a lane to book it', undefined, 2500)}
            />
          </div>
        )}

        {drawerOpen && !isPhone && (
          <ConflictDrawer
            conflicts={conflicts}
            onSelect={selectConflict}
            onClose={() => setDrawerOpen(false)}
          />
        )}
      </div>

      {isPhone && team && (
        <nav className="m-bottombar" aria-label="Board actions">
          <button
            type="button"
            className={`m-peek${conflicts.length ? ' has-conflicts' : ''}`}
            aria-expanded={sheet.kind === 'conflicts'}
            onClick={() => setSheet((s) => (s.kind === 'conflicts' ? { kind: 'none' } : { kind: 'conflicts' }))}
          >
            {conflicts.length > 0 && <span className="marker" aria-hidden="true" />}
            <span>{conflictLabel}</span>
            {conflicts.length > 0 && (
              <svg className="m-peek-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 10 4-4 4 4" /></svg>
            )}
          </button>
          {data?.projects.length ? (
            <button type="button" className="btn m-book" onClick={() => { setSheet({ kind: 'none' }); openNewBooking(); }}>
              Book
            </button>
          ) : null}
        </nav>
      )}

      {isPhone && sheet.kind === 'conflicts' && conflicts.length > 0 && (
        <>
          <div className="sheet-scrim" onClick={() => setSheet({ kind: 'none' })} aria-hidden="true" />
          <section className="sheet conflict-sheet" role="dialog" aria-label="Double-bookings">
            <ConflictList conflicts={conflicts} onSelect={selectConflict} />
          </section>
        </>
      )}

      {isPhone && sheet.kind === 'booking' && preview && (() => {
        const live = preview.bookings.find((b) => b.id === sheet.id);
        const saved = data?.bookings.find((b) => b.id === sheet.id);
        if (!live || !saved) return null;
        return (
          <BookingSheet
            booking={live}
            inConflict={conflicts.some((c) => c.booking_ids.includes(live.id))}
            onNudge={(m, d) => nudge(saved, m, d)}
            onEdit={() => { setSheet({ kind: 'none' }); openBooking(saved); }}
            onClose={() => setSheet({ kind: 'none' })}
          />
        );
      })()}

      {isPhone && sheet.kind === 'board' && (
        <BoardSheet
          teams={boot.teams}
          teamId={teamId}
          environments={environments}
          hidden={hiddenEnvs}
          conflicts={data?.conflicts ?? []}
          onSelectTeam={(id) => { switchTeam(id); setSheet({ kind: 'none' }); }}
          onToggleEnv={toggleEnv}
          onManage={(what) => { setSheet({ kind: 'none' }); setDialog({ kind: what }); }}
          onClose={() => setSheet({ kind: 'none' })}
        />
      )}

      {toast && (
        <div className="toast" role="status">
          <span className="toast-text">{toast.text}</span>
          {toast.undoId != null && (
            <button type="button" className="toast-action" onClick={() => void undoCreate()}>Undo</button>
          )}
        </div>
      )}

      {drag && (
        <DragReadout
          drag={drag}
          holidays={holidaySet}
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
            remember(d.project_id, d.environment_id);
            const body = {
              project_id: d.project_id,
              environment_id: d.environment_id,
              kind: d.kind as BookingView['kind'],
              start_date: d.start_date,
              end_date: d.end_date,
              confidence: d.confidence as BookingView['confidence'],
              optional: d.optional ? 1 : 0,
              note: d.note.trim() || null,
              marker: d.kind === 'CUSTOM' ? d.marker : null,
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
          busy={busy}
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
          busy={busy}
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
          busy={busy}
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
