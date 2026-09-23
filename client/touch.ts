import { useEffect, useRef, useState, type RefObject } from 'react';

/**
 * Touch rules for the board. On a phone the same finger scrolls the board and
 * edits a booking, so a bar must not grab a touch that is really a swipe.
 * A touch becomes an edit only once it has been held still.
 */
export const LONG_PRESS_MS = 400;
/** Further than this before the long press fires, and the touch is a scroll. */
export const TOUCH_SLOP_PX = 8;
/** How far fingers must spread or pinch before the zoom steps. */
export const PINCH_RATIO = 1.3;

export type TouchIntent = 'wait' | 'tap' | 'scroll' | 'pickup';

/**
 * What a touch on a bar that has not been picked up is doing so far.
 * Travel wins over time: a finger that moved is scrolling, however long it was down.
 */
export function classifyTouch(travelled: number, elapsedMs: number, released: boolean): TouchIntent {
  if (travelled > TOUCH_SLOP_PX) return 'scroll';
  if (elapsedMs >= LONG_PRESS_MS) return 'pickup';
  return released ? 'tap' : 'wait';
}

/**
 * One zoom step per pinch: +1 spreads to a finer grain, -1 pinches to a coarser one.
 * Discrete on purpose, so the ruler only ever runs at the three tested scales.
 */
export function pinchStep(startDistance: number, distance: number): -1 | 0 | 1 {
  if (startDistance <= 0) return 0;
  const ratio = distance / startDistance;
  if (ratio >= PINCH_RATIO) return 1;
  if (ratio <= 1 / PINCH_RATIO) return -1;
  return 0;
}

function spread(touches: TouchList): number {
  const [a, b] = [touches[0], touches[1]];
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

/** Calls `onStep` at most once per two-finger gesture, with the pinch's midpoint. */
export function usePinchZoom(
  ref: RefObject<HTMLElement>,
  onStep: (step: 1 | -1, clientX: number) => void,
) {
  const onStepRef = useRef(onStep);
  onStepRef.current = onStep;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let start = 0;
    let fired = false;

    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 2) return;
      start = spread(e.touches);
      fired = false;
    };
    const onMove = (e: TouchEvent) => {
      if (e.touches.length !== 2 || fired || !start) return;
      const step = pinchStep(start, spread(e.touches));
      if (step === 0) return;
      fired = true;
      onStepRef.current(step, (e.touches[0].clientX + e.touches[1].clientX) / 2);
    };
    const onEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) start = 0;
    };

    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: true });
    el.addEventListener('touchend', onEnd, { passive: true });
    el.addEventListener('touchcancel', onEnd, { passive: true });
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onEnd);
    };
  });
}

export const PHONE_QUERY = '(max-width: 640px)';

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const list = window.matchMedia(query);
    const update = () => setMatches(list.matches);
    update();
    list.addEventListener('change', update);
    return () => list.removeEventListener('change', update);
  }, [query]);
  return matches;
}
