import type { Note } from '../types';

export const MIN_MIDI = 0;
export const MAX_MIDI = 127;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function quantizePitchMidi(pitch: number, fine: boolean): number {
  const step = fine ? 0.25 : 1;
  const finitePitch = Number.isFinite(pitch) ? pitch : MIN_MIDI;
  return clamp(Math.round(finitePitch / step) * step, MIN_MIDI, MAX_MIDI);
}

export function updateNotePitch(note: Note, pitch: number, fine: boolean): Note {
  const targetPitchMidi = quantizePitchMidi(pitch, fine);
  return {
    ...note,
    targetPitchMidi,
    centsOffset: (targetPitchMidi - note.originalPitchMidi) * 100,
  };
}

export function nudgeNotePitch(note: Note, direction: -1 | 1, fine: boolean): Note {
  return updateNotePitch(note, note.targetPitchMidi + direction * (fine ? 0.25 : 1), fine);
}

export function resetNotePitch(note: Note): Note {
  return updateNotePitch(note, Math.round(note.originalPitchMidi), false);
}

export function isNotePitchEdited(note: Note): boolean {
  return Math.abs(note.targetPitchMidi - Math.round(note.originalPitchMidi)) > 0.0001;
}

export function noteStateSignature(notes: Note[]): string {
  return notes.map((note) => `${note.id}:${note.targetPitchMidi}:${note.centsOffset}`).join('|');
}
