const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

function isUnsafeFilenameCode(code: number): boolean {
  return code < 32 || code === 127 || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
}

export function outputBaseName(name: string): string {
  const withoutExtension = name.replace(/\.[^/.]+$/, '');
  const safe = Array.from(withoutExtension, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return isUnsafeFilenameCode(code) || '\\/:*?"<>|'.includes(character) ? '_' : character;
  }).join('').trim().replace(/^\.+/, '').replace(/[. ]+$/, '');
  if (!safe || safe === '.' || safe === '..') return 'pitchform';
  return WINDOWS_RESERVED_NAME.test(safe) ? `pitchform-${safe}` : safe;
}
