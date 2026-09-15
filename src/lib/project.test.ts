import { describe, expect, it } from 'vitest';
import { createPitchformProject, isPitchformProject, projectToJson } from './project';

describe('project format', () => {
  it('round-trips the versioned project envelope as JSON', () => {
    const project = createPitchformProject(
      { name: 'vocal.wav', size: 10, lastModified: 0, sha256: 'abc123' },
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
});

