import { describe, expect, it } from 'vitest';
import { isNotePitchEdited, nudgeNotePitch, noteStateSignature, quantizePitchMidi, resetNotePitch, updateNotePitch } from './editor';
import type { Note } from '../types';

const note: Note = {
  id: 'note-1',
  startSeconds: 0,
  endSeconds: 1,
  originalPitchMidi: 60.2,
  targetPitchMidi: 60,
  centsOffset: -20,
  confidence: 0.9,
};

describe('note editing helpers', () => {
  it('quantizes normal and fine pitch edits inside the MIDI range', () => {
    expect(quantizePitchMidi(60.49, false)).toBe(60);
    expect(quantizePitchMidi(60.49, true)).toBe(60.5);
    expect(quantizePitchMidi(-20, false)).toBe(0);
    expect(quantizePitchMidi(200, false)).toBe(127);
  });

  it('keeps cents offset derived from the target pitch', () => {
    const updated = updateNotePitch(note, 61.24, true);
    expect(updated.targetPitchMidi).toBe(61.25);
    expect(updated.centsOffset).toBeCloseTo(105);
    expect(isNotePitchEdited(updated)).toBe(true);
  });

  it('nudges by semitones or quarter tones and resets safely', () => {
    expect(nudgeNotePitch(note, 1, false).targetPitchMidi).toBe(61);
    expect(nudgeNotePitch(note, 1, true).targetPitchMidi).toBe(60.25);
    expect(nudgeNotePitch({ ...note, targetPitchMidi: 60.25 }, 1, false).targetPitchMidi).toBe(61);
    expect(resetNotePitch({ ...note, targetPitchMidi: 63, centsOffset: 280 }).targetPitchMidi).toBe(60);
    expect(isNotePitchEdited(note)).toBe(false);
  });

  it('creates a stable signature for dirty-state tracking', () => {
    expect(noteStateSignature([note])).toBe('note-1:60:-20');
    expect(noteStateSignature([updateNotePitch(note, 61, false)])).not.toBe(noteStateSignature([note]));
  });
});
