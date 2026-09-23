import { describe, expect, it } from 'vitest';
import { classifyTouch, LONG_PRESS_MS, pinchStep, PINCH_RATIO, TOUCH_SLOP_PX } from '../client/touch.ts';

describe('classifyTouch', () => {
  it('waits while a finger is down and still', () => {
    expect(classifyTouch(0, 100, false)).toBe('wait');
    expect(classifyTouch(TOUCH_SLOP_PX, LONG_PRESS_MS - 1, false)).toBe('wait');
  });

  it('picks the bar up after a still long press', () => {
    expect(classifyTouch(0, LONG_PRESS_MS, false)).toBe('pickup');
    expect(classifyTouch(TOUCH_SLOP_PX, LONG_PRESS_MS + 200, false)).toBe('pickup');
  });

  it('treats a quick still release as a tap', () => {
    expect(classifyTouch(2, 120, true)).toBe('tap');
  });

  it('gives a moving finger to the scroll, however long it was down', () => {
    // The whole point: a swipe that starts on a bar must scroll the board, not drag the bar.
    expect(classifyTouch(TOUCH_SLOP_PX + 1, 50, false)).toBe('scroll');
    expect(classifyTouch(TOUCH_SLOP_PX + 1, LONG_PRESS_MS * 3, false)).toBe('scroll');
    expect(classifyTouch(40, 80, true)).toBe('scroll');
  });
});

describe('pinchStep', () => {
  it('steps finer on a spread and coarser on a pinch', () => {
    expect(pinchStep(100, 100 * PINCH_RATIO)).toBe(1);
    expect(pinchStep(100, 100 / PINCH_RATIO)).toBe(-1);
  });

  it('ignores small wobbles between two fingers', () => {
    expect(pinchStep(100, 110)).toBe(0);
    expect(pinchStep(100, 90)).toBe(0);
  });

  it('ignores a degenerate start', () => {
    expect(pinchStep(0, 50)).toBe(0);
  });
});
