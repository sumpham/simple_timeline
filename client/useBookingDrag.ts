import { useCallback, useEffect, useRef, useState } from 'react';
import type { HolidaySet } from '../shared/dates.ts';
import type { BookingView } from '../shared/types.ts';
import { applyDrag, sameSpan, type DragMode, type Span } from './dragMath.ts';
import { classifyTouch, LONG_PRESS_MS } from './touch.ts';

export type DragSession = {
  booking: BookingView;
  mode: DragMode;
  span: Span;
  /** Pointer position, for the floating readout. */
  x: number;
  y: number;
  /** True once the span differs from where the booking started. */
  changed: boolean;
  /** A finger covers whatever sits under it, so a touch drag pins the readout instead. */
  touch: boolean;
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
 *
 * Touch adds one step in front. A finger on a bar is usually the start of a
 * swipe, so the bar only takes the gesture after a still long press (see
 * `classifyTouch`). The bar then stays picked up, showing its resize tabs, and
 * further touches on it drag straight away until something else is touched.
 */
export function useBookingDrag(options: Options) {
  const [session, setSession] = useState<DragSession | null>(null);
  const [picked, setPicked] = useState<number | null>(null);

  // The live options, so the window listeners never close over a stale zoom level.
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const pickedRef = useRef(picked);
  pickedRef.current = picked;

  const gesture = useRef<{
    originX: number;
    booking: BookingView;
    mode: DragMode;
    span: Span;
    travelled: number;
    cancelled: boolean;
    touch: boolean;
    /** Began with a long press; lifting that finger is not a tap on the bar. */
    pickedUp: boolean;
  } | null>(null);

  /** A touch waiting to find out whether it is a tap, a swipe or a long press. */
  const waiting = useRef<{ cleanup: () => void } | null>(null);

  const start = useCallback((
    booking: BookingView, mode: DragMode, x: number, y: number, touch: boolean, pickedUp = false,
  ) => {
    const span: Span = { start: booking.start_date, end: booking.end_date };
    gesture.current = { originX: x, booking, mode, span, travelled: 0, cancelled: false, touch, pickedUp };
    setSession({ booking, mode, span, x, y, changed: false, touch });
  }, []);

  const waitForLongPress = useCallback((booking: BookingView, event: React.PointerEvent) => {
    waiting.current?.cleanup();
    const { pointerId, clientX: x0, clientY: y0 } = event;
    const t0 = performance.now();
    let travelled = 0;

    const done = () => {
      clearTimeout(timer);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', done);
      waiting.current = null;
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      travelled = Math.max(travelled, Math.hypot(e.clientX - x0, e.clientY - y0));
      if (classifyTouch(travelled, performance.now() - t0, false) === 'scroll') done();
    };
    const onUp = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      const intent = classifyTouch(travelled, performance.now() - t0, true);
      done();
      if (intent === 'tap') optionsRef.current.onSelect(booking);
    };
    const timer = setTimeout(() => {
      if (classifyTouch(travelled, LONG_PRESS_MS, false) !== 'pickup') return done();
      done();
      navigator.vibrate?.(12);
      setPicked(booking.id);
      // Measured from where the finger landed, so any creep before the pickup counts.
      start(booking, 'move', x0, y0, true, true);
    }, LONG_PRESS_MS);

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    // The browser took the touch for a scroll.
    window.addEventListener('pointercancel', done);
    waiting.current = { cleanup: done };
  }, [start]);

  const begin = useCallback((booking: BookingView, mode: DragMode, event: React.PointerEvent) => {
    if (event.button !== 0) return;
    // A resize handle on a milestone makes no sense: it is one day by definition.
    if (booking.is_milestone && mode !== 'move') return;
    event.stopPropagation();

    const touch = event.pointerType === 'touch';
    if (touch && pickedRef.current !== booking.id) {
      // No preventDefault: until the long press lands, the browser may scroll.
      waitForLongPress(booking, event);
      return;
    }

    event.preventDefault();
    start(booking, mode, event.clientX, event.clientY, touch);
  }, [start, waitForLongPress]);

  /** Put a picked-up bar back down, hiding its resize tabs. */
  const drop = useCallback(() => setPicked(null), []);

  useEffect(() => () => waiting.current?.cleanup(), []);

  const active = session !== null;
  const touchActive = session?.touch ?? false;

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
        touch: g.touch,
      });
    };

    const onPointerUp = () => {
      const g = gesture.current;
      gesture.current = null;
      setSession(null);
      if (!g || g.cancelled) return;

      if (g.travelled <= CLICK_SLOP_PX) {
        if (!g.pickedUp) optionsRef.current.onSelect(g.booking);
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

    // Once a finger holds a bar, the board must stop scrolling under it.
    const holdStill = (event: TouchEvent) => { if (event.cancelable) event.preventDefault(); };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    window.addEventListener('keydown', onKeyDown);
    if (touchActive) window.addEventListener('touchmove', holdStill, { passive: false });
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('touchmove', holdStill);
    };
  }, [active, touchActive]);

  return { session, begin, picked, drop };
}
