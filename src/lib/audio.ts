import type { Note } from '../types';

export function audioBufferToMono(buffer: AudioBuffer): Float32Array {
  const mono = new Float32Array(buffer.length);
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let index = 0; index < buffer.length; index += 1) mono[index] += data[index] / buffer.numberOfChannels;
  }
  return mono;
}

function sampleToPcm16(sample: number): number {
  const finite = Number.isFinite(sample) ? sample : 0;
  const clipped = Math.max(-1, Math.min(1, finite));
  return clipped < 0 ? clipped * 0x8000 : clipped * 0x7fff;
}

export function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;
  const view = new DataView(new ArrayBuffer(44 + dataSize));
  const writeString = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
  };
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);
  for (let index = 0; index < samples.length; index += 1) view.setInt16(44 + index * 2, sampleToPcm16(samples[index]), true);
  return view.buffer;
}

export function renderCorrectedSamples(samples: Float32Array, sampleRate: number, notes: Note[]): Float32Array {
  const rendered = new Float32Array(samples);
  for (const note of notes) {
    const start = Math.max(0, Math.floor(note.startSeconds * sampleRate));
    const end = Math.min(samples.length, Math.ceil(note.endSeconds * sampleRate));
    if (end <= start) continue;
    const ratio = 2 ** ((note.targetPitchMidi - note.originalPitchMidi) / 12);
    if (!Number.isFinite(ratio) || Math.abs(ratio - 1) < 0.0001) continue;
    for (let index = start; index < end; index += 1) {
      const local = (index - start) * ratio;
      const sourcePosition = Math.min(end - 1, Math.max(0, start + local));
      const left = Math.floor(sourcePosition);
      const right = Math.min(end - 1, left + 1);
      const fraction = sourcePosition - left;
      rendered[index] = samples[left] * (1 - fraction) + samples[right] * fraction;
    }
  }
  return rendered;
}

export function createMonoAudioBuffer(context: BaseAudioContext, samples: Float32Array, sampleRate: number): AudioBuffer {
  const buffer = context.createBuffer(1, samples.length, sampleRate);
  const copy = new Float32Array(samples.length);
  copy.set(samples);
  buffer.copyToChannel(copy, 0);
  return buffer;
}
