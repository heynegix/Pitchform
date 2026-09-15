import { encodeWav } from './audio';
import type { AudioSourceMetadata, EditorState, Note, PitchFrame, PitchformProject } from '../types';

export const PITCHFORM_VERSION = '0.1.0';
export const MAX_PROJECT_FILE_BYTES = 256_000_000;
const MAX_AUDIO_BASE64_LENGTH = MAX_PROJECT_FILE_BYTES;
const MAX_FRAMES = 5_000_000;
const MAX_NOTES = 250_000;

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
  const maxPcmSamples = Math.floor((MAX_AUDIO_BASE64_LENGTH * 3 - 44 * 4) / 8);
  if (samples.length > maxPcmSamples) throw new RangeError('Audio is too large to embed in a .pitchform project.');
  const wav = encodeWav(samples, sampleRate);
  const audioWavBase64 = bytesToBase64(new Uint8Array(wav));
  if (audioWavBase64.length > MAX_AUDIO_BASE64_LENGTH) throw new RangeError('Audio is too large to embed in a .pitchform project.');
  const copiedNotes = notes.map((note) => ({ ...note }));
  return {
    format: 'pitchform',
    formatVersion: 1,
    pitchformVersion: PITCHFORM_VERSION,
    createdAt: new Date().toISOString(),
    sourceAudio: { ...sourceAudio },
    analysis: { sampleRate, durationSeconds, frames: frames.map((frame) => ({ ...frame })) },
    notes: copiedNotes,
    edits: { notes: copiedNotes.map((note) => ({ ...note })) },
    editorState: { ...editorState },
    audioWavBase64,
  };
}

export function isPitchformProject(value: unknown): value is PitchformProject {
  if (typeof value !== 'object' || value === null) return false;
  const project = value as Partial<PitchformProject>;
  const analysis = project.analysis;
  const source = project.sourceAudio;
  const editorState = project.editorState;
  const notes = project.edits?.notes;
  const durationSeconds = analysis?.durationSeconds;
  const sameNote = (left: Note, right: Note) => left.id === right.id
    && left.startSeconds === right.startSeconds
    && left.endSeconds === right.endSeconds
    && left.originalPitchMidi === right.originalPitchMidi
    && left.targetPitchMidi === right.targetPitchMidi
    && left.centsOffset === right.centsOffset
    && left.confidence === right.confidence;
  const validFrame = (frame: unknown) => {
    if (typeof frame !== 'object' || frame === null) return false;
    const item = frame as Partial<import('../types').PitchFrame>;
    const timeSeconds = item.timeSeconds;
    const confidence = item.confidence;
    return typeof timeSeconds === 'number'
      && Number.isFinite(timeSeconds)
      && timeSeconds >= 0
      && typeof durationSeconds === 'number'
      && Number.isFinite(durationSeconds)
      && timeSeconds <= durationSeconds
      && typeof item.voiced === 'boolean'
      && typeof confidence === 'number'
      && Number.isFinite(confidence)
      && confidence >= 0 && confidence <= 1
      && (item.midi === null || (Number.isFinite(item.midi) && (item.midi as number) >= -128 && (item.midi as number) <= 256))
      && (item.frequencyHz === null || (Number.isFinite(item.frequencyHz) && (item.frequencyHz as number) > 0))
      && (item.voiced ? item.midi !== null && item.frequencyHz !== null : item.midi === null && item.frequencyHz === null);
  };
  const validNote = (note: unknown) => {
    if (typeof note !== 'object' || note === null) return false;
    const item = note as Partial<import('../types').Note>;
    const startSeconds = item.startSeconds;
    const endSeconds = item.endSeconds;
    const confidence = item.confidence;
    return typeof item.id === 'string' && item.id.length > 0 && item.id.length < 128
      && typeof startSeconds === 'number' && typeof endSeconds === 'number'
      && Number.isFinite(startSeconds) && Number.isFinite(endSeconds)
      && startSeconds >= 0 && endSeconds > startSeconds
      && typeof durationSeconds === 'number' && Number.isFinite(durationSeconds) && endSeconds <= durationSeconds
      && Number.isFinite(item.originalPitchMidi) && (item.originalPitchMidi as number) >= -128 && (item.originalPitchMidi as number) <= 256
      && Number.isFinite(item.targetPitchMidi) && (item.targetPitchMidi as number) >= -128 && (item.targetPitchMidi as number) <= 256
      && Number.isFinite(item.centsOffset) && (item.centsOffset as number) >= -38_400 && (item.centsOffset as number) <= 38_400
      && typeof confidence === 'number' && Number.isFinite(confidence)
      && confidence >= 0 && confidence <= 1;
  };
  return project.format === 'pitchform'
    && project.formatVersion === 1
    && project.pitchformVersion === PITCHFORM_VERSION
    && typeof project.createdAt === 'string' && Number.isFinite(Date.parse(project.createdAt))
    && typeof project.audioWavBase64 === 'string'
    && project.audioWavBase64.length > 0
    && project.audioWavBase64.length <= MAX_AUDIO_BASE64_LENGTH
    && project.audioWavBase64.length % 4 === 0
    && /^[A-Za-z0-9+/]*={0,2}$/.test(project.audioWavBase64)
    && typeof source?.name === 'string' && source.name.length > 0 && source.name.length < 1024
    && Number.isSafeInteger(source.size) && source.size >= 0
    && Number.isSafeInteger(source.lastModified) && source.lastModified >= 0 && typeof source.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(source.sha256)
    && typeof analysis?.sampleRate === 'number' && Number.isInteger(analysis.sampleRate) && analysis.sampleRate >= 1 && analysis.sampleRate <= 384_000
    && typeof analysis?.durationSeconds === 'number' && Number.isFinite(analysis.durationSeconds) && analysis.durationSeconds > 0 && analysis.durationSeconds <= 86_400
    && Array.isArray(analysis?.frames) && analysis.frames.length <= MAX_FRAMES && analysis.frames.every(validFrame)
    && Array.isArray(project.notes) && project.notes.length <= MAX_NOTES && project.notes.every(validNote)
    && new Set(project.notes.map((note) => note.id)).size === project.notes.length
    && Array.isArray(notes) && notes.length === project.notes.length && notes.every(validNote)
    && project.notes.every((note, index) => sameNote(note, notes[index]))
    && new Set(notes.map((note) => note.id)).size === notes.length
    && typeof editorState?.zoom === 'number' && Number.isFinite(editorState.zoom) && editorState.zoom >= 1 && editorState.zoom <= 16
    && typeof editorState?.scrollLeft === 'number' && Number.isFinite(editorState.scrollLeft) && editorState.scrollLeft >= 0
    && typeof editorState?.snapToSemitone === 'boolean';
}

export function projectToJson(project: PitchformProject): string {
  return JSON.stringify(project, null, 2);
}
