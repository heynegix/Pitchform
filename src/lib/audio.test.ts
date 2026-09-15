import { describe, expect, it } from 'vitest';
import { encodeWav, renderCorrectedSamples } from './audio';
import { analyzeMonophonic } from './analysis';
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
  it('sanitizes non-finite samples and clips at WAV encoding', () => {
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

  it('shifts a sustained tone while preserving the note duration', () => {
    const sampleRate = 44_100;
    const source = new Float32Array(sampleRate);
    for (let index = 0; index < source.length; index += 1) source[index] = 0.35 * Math.sin(2 * Math.PI * 440 * index / sampleRate);
    const rendered = renderCorrectedSamples(source, sampleRate, [{
      ...note,
      startSeconds: 0.1,
      endSeconds: 0.9,
      originalPitchMidi: 69,
      targetPitchMidi: 72,
    }]);
    const middle = rendered.slice(Math.floor(sampleRate * 0.25), Math.floor(sampleRate * 0.75));
    const voiced = analyzeMonophonic(middle, sampleRate).filter((frame) => frame.voiced && frame.midi !== null);
    const averageMidi = voiced.reduce((sum, frame) => sum + (frame.midi as number), 0) / voiced.length;
    expect(rendered).toHaveLength(source.length);
    expect(voiced.length).toBeGreaterThan(5);
    expect(averageMidi).toBeCloseTo(72, 0.6);
  });

  it('does not mutate source samples while rendering', () => {
    const source = new Float32Array([0.1, 0.2, 0.3, 0.4]);
    const original = source.slice();
    renderCorrectedSamples(source, 4, [note]);
    expect(source).toEqual(original);
  });

  it('does not edit samples outside the note boundary', () => {
    const sampleRate = 44_100;
    const source = new Float32Array(sampleRate);
    for (let index = 0; index < source.length; index += 1) source[index] = 0.25 * Math.sin(index / 9);
    const start = Math.floor(sampleRate * 0.2);
    const end = Math.floor(sampleRate * 0.8);
    const rendered = renderCorrectedSamples(source, sampleRate, [{
      ...note,
      startSeconds: 0.2,
      endSeconds: 0.8,
      originalPitchMidi: 69,
      targetPitchMidi: 72,
    }]);
    expect(rendered.slice(0, start)).toEqual(source.slice(0, start));
    expect(rendered.slice(end)).toEqual(source.slice(end));
  });

  it('rejects fractional WAV sample rates', () => {
    expect(() => encodeWav(new Float32Array(1), 44_100.5)).toThrow(RangeError);
  });

  it('does not mute the source when the render rate is invalid', () => {
    const source = new Float32Array([0.25, Number.NaN, -0.5]);
    expect(renderCorrectedSamples(source, Number.NaN, [])).toEqual(new Float32Array([0.25, 0, -0.5]));
  });

  it('keeps extreme pitch edits finite and bounded in memory', () => {
    const source = new Float32Array(20_000);
    for (let index = 0; index < source.length; index += 1) source[index] = 0.2 * Math.sin(index / 7);
    const rendered = renderCorrectedSamples(source, 20_000, [{
      ...note,
      endSeconds: 1,
      originalPitchMidi: -128,
      targetPitchMidi: 256,
    }]);
    expect(rendered).toHaveLength(source.length);
    expect([...rendered].every((sample) => Number.isFinite(sample))).toBe(true);
  });
});
