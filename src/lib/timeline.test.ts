import { describe, expect, it } from 'vitest';
import { clientXToSeconds, isClientXInTimeline, secondsToCanvasX, TIMELINE_GUTTER_PX } from './timeline';

describe('timeline coordinates', () => {
  it('keeps the piano gutter outside the time axis', () => {
    expect(secondsToCanvasX(0, 10, 1_052)).toBe(TIMELINE_GUTTER_PX);
    expect(secondsToCanvasX(10, 10, 1_052)).toBe(1_052);
    expect(clientXToSeconds(52, 0, 1_052, 10)).toBe(0);
    expect(clientXToSeconds(1_052, 0, 1_052, 10)).toBe(10);
  });

  it('clamps out-of-range clicks and ignores invalid geometry', () => {
    expect(secondsToCanvasX(-1, 10, 1_052)).toBe(TIMELINE_GUTTER_PX);
    expect(clientXToSeconds(-100, 0, 1_052, 10)).toBe(0);
    expect(clientXToSeconds(2_000, 0, 1_052, 10)).toBe(10);
    expect(clientXToSeconds(Number.NaN, 0, 1_052, 10)).toBe(0);
    expect(isClientXInTimeline(20, 0, 1_052)).toBe(false);
    expect(isClientXInTimeline(52, 0, 1_052)).toBe(true);
    expect(isClientXInTimeline(1_052, 0, 1_052)).toBe(true);
  });
});
