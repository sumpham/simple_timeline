import { useCallback, useEffect, useRef, useState } from 'react';
import type { HolidaySet } from '../shared/dates.ts';
import type { BookingView } from '../shared/types.ts';
import { applyDrag, sameSpan, type DragMode, type Span } from './dragMath.ts';

export type DragSession = {
  booking: BookingView;
  mode: DragMode;
  span: Span;
  /** Pointer position, for the floating readout. */
  x: number;
  y: number;
  /** True once the span differs from where the booking started. */
  changed: boolean;
};

type Options = {
  dayWidth: number;
  holidays: HolidaySet;
  /** Fired on release, only when the dates actually changed. */
  onCommit: (booking: BookingView, span: Span) => void | Promise<void>;
  /** Fired on release when the pointer never really moved — a click, not a drag. */
  onSelect: (booking: BookingView) => void;
  /**
   * Fired on every move with the provisional span, and with null when the drag is
   * abandoned. The board draws from this, so conflict detection sees where the bar
   * is going rather than where it still is.
   */
  onPreview: (bookingId: number, span: Span | null) => void;
};

const CLICK_SLOP_PX = 4;

/**
 * Pointer handling for dragging bars.
 *
 * Click and drag share a gesture, so the distinction is made here rather than by
 * a click handler racing a drag: a release that never travelled past a few pixels
 * opens the booking, anything further commits new dates. Keyboard activation does
 * not pass through here at all — the bar's onClick handles that, keyed on
 * `event.detail === 0`, which only a keyboard produces.
 */
export function useBookingDrag(options: Options) {
  const [session, setSession] = useState<DragSession | null>(null);

  // The live options, so the window listeners never close over a stale zoom level.
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const gesture = useRef<{
    originX: number;
    booking: BookingView;
    mode: DragMode;
    span: Span;
    travelled: number;
    cancelled: boolean;
  } | null>(null);

  const begin = useCallback((booking: BookingView, mode: DragMode, event: React.PointerEvent) => {
    if (event.button !== 0) return;
    // A resize handle on a milestone makes no sense: it is one day by definition.
    if (booking.is_milestone && mode !== 'move') return;
    event.preventDefault();
    event.stopPropagation();

    const span: Span = { start: booking.start_date, end: booking.end_date };
    gesture.current = { originX: event.clientX, booking, mode, span, travelled: 0, cancelled: false };
    setSession({ booking, mode, span, x: event.clientX, y: event.clientY, changed: false });
  }, []);

  const active = session !== null;

  useEffect(() => {
    if (!active) return;

    const onPointerMove = (event: PointerEvent) => {
      const g = gesture.current;
      if (!g) return;
      const { dayWidth, holidays } = optionsRef.current;

      const dx = event.clientX - g.originX;
      g.travelled = Math.max(g.travelled, Math.abs(dx));

      const span = applyDrag(g.booking, g.mode, Math.round(dx / dayWidth), holidays);
      const moved = span.start !== g.span.start || span.end !== g.span.end;
      g.span = span;

      // Feed the board so the bar, and the conflicts it may create, update live.
      if (moved) optionsRef.current.onPreview(g.booking.id, span);

      setSession({
        booking: g.booking,
        mode: g.mode,
        span,
        x: event.clientX,
        y: event.clientY,
        changed: !sameSpan(span, g.booking),
      });
    };

    const onPointerUp = () => {
      const g = gesture.current;
      gesture.current = null;
      setSession(null);
      if (!g || g.cancelled) return;

      if (g.travelled <= CLICK_SLOP_PX) {
        optionsRef.current.onSelect(g.booking);
      } else if (!sameSpan(g.span, g.booking)) {
        void optionsRef.current.onCommit(g.booking, g.span);
      }
    };

    // Escape abandons the drag and leaves the booking where it was.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !gesture.current) return;
      optionsRef.current.onPreview(gesture.current.booking.id, null);
      gesture.current.cancelled = true;
      gesture.current = null;
      setSession(null);
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [active]);

  return { session, begin };
}
