import { describe, expect, it } from 'vitest';
import { encodeWav, renderCorrectedSamples } from './audio';
import type { Note } from '../types';

const note: Note = {
  id: 'note-1',
  startSeconds: 0,
  endSeconds: 1,
  originalPitchMidi: 69,
  targetPitchMidi: 81,
  centsOffset: 1200,
  confidence: 1,
};

describe('audio rendering', () => {
  it('keeps samples finite and within the PCM range', () => {
    const source = new Float32Array([0, 0.5, 1.5, Number.NaN, -2]);
    const rendered = renderCorrectedSamples(source, 5, []);
    expect([...rendered]).toEqual([0, 0.5, 1.5, 0, -2]);
    const wav = new DataView(encodeWav(rendered, 5));
    expect(wav.getUint32(24, true)).toBe(5);
    expect(wav.getUint32(40, true)).toBe(10);
    expect(wav.getInt16(44 + 3 * 2, true)).toBe(0);
    expect(wav.getInt16(44 + 4 * 2, true)).toBe(-32768);
  });

  it('ignores malformed notes and rejects an invalid WAV rate', () => {
    const source = new Float32Array([0, 1, 0, -1]);
    const malformed = { ...note, startSeconds: Number.NaN };
    expect(renderCorrectedSamples(source, 4, [malformed])).toEqual(source);
    expect(() => encodeWav(source, 0)).toThrow(RangeError);
  });

  it('changes a note without changing its output length', () => {
    const source = new Float32Array(100);
    for (let index = 0; index < source.length; index += 1) source[index] = Math.sin(index / 5);
    const rendered = renderCorrectedSamples(source, 100, [note]);
    expect(rendered).toHaveLength(source.length);
    expect(rendered).not.toEqual(source);
  });

  it('does not mutate source samples while rendering', () => {
    const source = new Float32Array([0.1, 0.2, 0.3, 0.4]);
    const original = source.slice();
    renderCorrectedSamples(source, 4, [note]);
    expect(source).toEqual(original);
  });

  it('rejects fractional WAV sample rates', () => {
    expect(() => encodeWav(new Float32Array(1), 44_100.5)).toThrow(RangeError);
  });

  it('does not mute the source when the render rate is invalid', () => {
    const source = new Float32Array([0.25, Number.NaN, -0.5]);
    expect(renderCorrectedSamples(source, Number.NaN, [])).toEqual(new Float32Array([0.25, 0, -0.5]));
  });
});
