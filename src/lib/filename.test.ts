import { describe, expect, it } from 'vitest';
import { outputBaseName } from './filename';

describe('download filenames', () => {
  it('removes extensions and path/control characters', () => {
    expect(outputBaseName('take/../vocal\u202E.wav')).toBe('take_.._vocal_');
  });

  it('avoids empty, dot-only, and Windows device names', () => {
    expect(outputBaseName('...wav')).toBe('pitchform');
    expect(outputBaseName('CON.wav')).toBe('pitchform-CON');
  });
});
