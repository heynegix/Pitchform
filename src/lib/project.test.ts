import { describe, expect, it } from 'vitest';
import { createPitchformProject, isPitchformProject, projectToJson } from './project';

describe('project format', () => {
  it('round-trips the versioned project envelope as JSON', () => {
    const project = createPitchformProject(
      { name: 'vocal.wav', size: 10, lastModified: 0, sha256: 'a'.repeat(64) },
      100,
      0.04,
      new Float32Array([0, 0.25, -0.25, 0]),
      [{ timeSeconds: 0.02, frequencyHz: 440, midi: 69, confidence: 0.9, voiced: true }],
      [],
      { zoom: 1, scrollLeft: 0, snapToSemitone: true },
    );
    const parsed: unknown = JSON.parse(projectToJson(project));
    expect(isPitchformProject(parsed)).toBe(true);
    expect((parsed as typeof project).audioWavBase64.length).toBeGreaterThan(0);
    expect((parsed as typeof project).analysis.sampleRate).toBe(100);
  });

  it('rejects malformed projects before decoding their embedded audio', () => {
    const malformed: unknown = {
      format: 'pitchform',
      formatVersion: 1,
      pitchformVersion: '0.1.0',
      createdAt: new Date().toISOString(),
      sourceAudio: { name: 'vocal.wav', size: 1, lastModified: 0, sha256: 'not-a-hash' },
      analysis: { sampleRate: 44_100, durationSeconds: 1, frames: [] },
      notes: [],
      edits: { notes: [] },
      editorState: { zoom: 1, scrollLeft: 0, snapToSemitone: true },
      audioWavBase64: 'AAAA',
    };
    expect(isPitchformProject(malformed)).toBe(false);
  });

  it('rejects inconsistent edit copies and invalid base64 envelopes', () => {
    const note = { id: 'note-1', startSeconds: 0, endSeconds: 0.02, originalPitchMidi: 69, targetPitchMidi: 69, centsOffset: 0, confidence: 1 };
    const project = createPitchformProject(
      { name: 'vocal.wav', size: 10, lastModified: 0, sha256: 'b'.repeat(64) },
      100,
      0.04,
      new Float32Array([0, 0.25, -0.25, 0]),
      [],
      [note],
      { zoom: 1, scrollLeft: 0, snapToSemitone: true },
    );
    const edited = {
      ...project,
      edits: { notes: [{ ...note, targetPitchMidi: 70, centsOffset: 100 }] },
    };
    expect(isPitchformProject(edited)).toBe(true);
    expect(isPitchformProject({ ...project, edits: { notes: [{ ...note, startSeconds: 0.01 }] } })).toBe(false);
    expect(isPitchformProject({ ...project, audioWavBase64: 'AAAAA' })).toBe(false);
  });

  it('accepts a valid loop selection and rejects malformed loop state', () => {
    const project = createPitchformProject(
      { name: 'vocal.wav', size: 10, lastModified: 0, sha256: 'c'.repeat(64) },
      100,
      0.04,
      new Float32Array([0, 0.25, -0.25, 0]),
      [],
      [],
      { zoom: 1, scrollLeft: 0, snapToSemitone: true, loopStartSeconds: 0.01, loopEndSeconds: 0.03 },
    );
    expect(isPitchformProject(project)).toBe(true);
    expect(isPitchformProject({
      ...project,
      editorState: { ...project.editorState, loopStartSeconds: -0.01 },
    })).toBe(false);
    expect(isPitchformProject({
      ...project,
      editorState: { ...project.editorState, loopStartSeconds: null, loopEndSeconds: 0.03 },
    })).toBe(false);
    expect(isPitchformProject({
      ...project,
      editorState: { ...project.editorState, loopStartSeconds: 0.03, loopEndSeconds: 0.01 },
    })).toBe(false);
  });
});
