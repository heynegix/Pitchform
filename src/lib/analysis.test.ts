import { describe, expect, it } from 'vitest';
import { analyzeMonophonic, frequencyToMidi, segmentNotes } from './analysis';

function sineWave(frequency: number, sampleRate: number, seconds: number): Float32Array {
  const samples = new Float32Array(Math.floor(sampleRate * seconds));
  for (let index = 0; index < samples.length; index += 1) samples[index] = 0.4 * Math.sin(2 * Math.PI * frequency * index / sampleRate);
  return samples;
}

describe('pitch analysis', () => {
  it('converts frequency to MIDI pitch', () => {
    expect(frequencyToMidi(440)).toBeCloseTo(69, 5);
    expect(frequencyToMidi(220)).toBeCloseTo(57, 5);
  });

  it('detects a synthetic A4 within a small cents error', () => {
    const sampleRate = 44100;
    const frames = analyzeMonophonic(sineWave(440, sampleRate, 0.5), sampleRate);
    const voiced = frames.filter((frame) => frame.voiced && frame.midi !== null);
    expect(voiced.length).toBeGreaterThan(5);
    const average = voiced.reduce((sum, frame) => sum + (frame.midi as number), 0) / voiced.length;
    expect(average).toBeCloseTo(69, 1);
  });

  it('does not invent voiced frames from silence or non-finite samples', () => {
    const samples = new Float32Array(5000);
    samples.fill(Number.NaN);
    const frames = analyzeMonophonic(samples, 44100);
    expect(frames.some((frame) => frame.voiced)).toBe(false);
  });

  it('rejects invalid sample rates and keeps frame timestamps inside the clip', () => {
    expect(analyzeMonophonic(sineWave(440, 44100, 0.1), Number.NaN)).toEqual([]);
    expect(analyzeMonophonic(sineWave(440, 44100, 0.1), 44_100.5)).toEqual([]);
    const duration = 0.037;
    const frames = analyzeMonophonic(sineWave(440, 44100, duration), 44100);
    expect(Math.max(...frames.map((frame) => frame.timeSeconds))).toBeLessThanOrEqual(duration);
  });
});

describe('note segmentation', () => {
  it('creates separate notes for a pitch jump and ignores silence', () => {
    const frames = [
      ...Array.from({ length: 8 }, (_, index) => ({ timeSeconds: index * 0.05, frequencyHz: 440, midi: 69, confidence: 0.9, voiced: true })),
      { timeSeconds: 0.4, frequencyHz: null, midi: null, confidence: 0, voiced: false },
      ...Array.from({ length: 8 }, (_, index) => ({ timeSeconds: 0.45 + index * 0.05, frequencyHz: 523.25, midi: 72, confidence: 0.9, voiced: true })),
    ];
    const notes = segmentNotes(frames, 0.9);
    expect(notes).toHaveLength(2);
    expect(notes[0].originalPitchMidi).toBeCloseTo(69, 4);
    expect(notes[1].originalPitchMidi).toBeCloseTo(72, 4);
  });
});
