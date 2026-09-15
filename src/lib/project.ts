import { encodeWav } from './audio';
import type { AudioSourceMetadata, EditorState, Note, PitchFrame, PitchformProject } from '../types';

export const PITCHFORM_VERSION = '0.1.0';

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, Math.min(index + chunkSize, bytes.length)));
  }
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function createPitchformProject(
  sourceAudio: AudioSourceMetadata,
  sampleRate: number,
  durationSeconds: number,
  samples: Float32Array,
  frames: PitchFrame[],
  notes: Note[],
  editorState: EditorState,
): PitchformProject {
  const wav = encodeWav(samples, sampleRate);
  return {
    format: 'pitchform',
    formatVersion: 1,
    pitchformVersion: PITCHFORM_VERSION,
    createdAt: new Date().toISOString(),
    sourceAudio,
    analysis: { sampleRate, durationSeconds, frames },
    notes,
    edits: { notes },
    editorState,
    audioWavBase64: bytesToBase64(new Uint8Array(wav)),
  };
}

export function isPitchformProject(value: unknown): value is PitchformProject {
  if (typeof value !== 'object' || value === null) return false;
  const project = value as Partial<PitchformProject>;
  return project.format === 'pitchform'
    && project.formatVersion === 1
    && typeof project.audioWavBase64 === 'string'
    && Array.isArray(project.analysis?.frames)
    && Array.isArray(project.edits?.notes);
}

export function projectToJson(project: PitchformProject): string {
  return JSON.stringify(project, null, 2);
}

