import type { Note } from '../types';

export const MAX_DECODED_CHANNEL_SAMPLES = 192_000_000;
export const MAX_AUDIO_DURATION_SECONDS = 3_600;

export function validateDecodedAudioBuffer(buffer: Pick<AudioBuffer, 'length' | 'numberOfChannels' | 'duration'>): void {
  const decodedChannelSamples = buffer.length * Math.max(1, buffer.numberOfChannels);
  if (!Number.isSafeInteger(decodedChannelSamples)
    || decodedChannelSamples > MAX_DECODED_CHANNEL_SAMPLES
    || !Number.isFinite(buffer.duration)
    || buffer.duration <= 0
    || buffer.duration > MAX_AUDIO_DURATION_SECONDS) {
    throw new Error('This audio is too long or expands to too much decoded data (maximum 60 minutes).');
  }
}

export function audioBufferToMono(buffer: AudioBuffer): Float32Array {
  const mono = new Float32Array(buffer.length);
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let index = 0; index < buffer.length; index += 1) {
      const sample = Number.isFinite(data[index]) ? data[index] : 0;
      mono[index] += sample / Math.max(1, buffer.numberOfChannels);
    }
  }
  for (let index = 0; index < mono.length; index += 1) {
    const sample = Number.isFinite(mono[index]) ? mono[index] : 0;
    mono[index] = Math.max(-1, Math.min(1, sample));
  }
  return mono;
}

function sampleToPcm16(sample: number): number {
  const finite = Number.isFinite(sample) ? sample : 0;
  const clipped = Math.max(-1, Math.min(1, finite));
  return clipped < 0 ? clipped * 0x8000 : clipped * 0x7fff;
}

export function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  if (!Number.isInteger(sampleRate) || sampleRate < 1 || sampleRate > 384_000) throw new RangeError('Invalid WAV sample rate.');
  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;
  if (!Number.isSafeInteger(dataSize) || dataSize > 0xffff_ffff - 36) throw new RangeError('WAV is too large to encode.');
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

const FFT_SIZE = 1_024;
const FFT_HOP = 256;
const MAX_PHASE_VOCODER_SEGMENT_SAMPLES = 2_000_000;
const RENDER_CONTEXT_MIN_SAMPLES = FFT_SIZE;
const RENDER_CONTEXT_MAX_SAMPLES = 4_096;

function wrapPhase(phase: number): number {
  return phase - 2 * Math.PI * Math.round(phase / (2 * Math.PI));
}

function transform(real: Float64Array, imaginary: Float64Array, inverse: boolean): void {
  for (let target = 1, reverse = 0; target < real.length; target += 1) {
    let bit = real.length >> 1;
    for (; reverse & bit; bit >>= 1) reverse ^= bit;
    reverse ^= bit;
    if (target < reverse) {
      [real[target], real[reverse]] = [real[reverse], real[target]];
      [imaginary[target], imaginary[reverse]] = [imaginary[reverse], imaginary[target]];
    }
  }

  for (let length = 2; length <= real.length; length <<= 1) {
    const angle = (inverse ? 2 : -2) * Math.PI / length;
    const stepReal = Math.cos(angle);
    const stepImaginary = Math.sin(angle);
    for (let start = 0; start < real.length; start += length) {
      let factorReal = 1;
      let factorImaginary = 0;
      const half = length >> 1;
      for (let offset = 0; offset < half; offset += 1) {
        const even = start + offset;
        const odd = even + half;
        const productReal = factorReal * real[odd] - factorImaginary * imaginary[odd];
        const productImaginary = factorReal * imaginary[odd] + factorImaginary * real[odd];
        real[odd] = real[even] - productReal;
        imaginary[odd] = imaginary[even] - productImaginary;
        real[even] += productReal;
        imaginary[even] += productImaginary;
        const nextFactorReal = factorReal * stepReal - factorImaginary * stepImaginary;
        factorImaginary = factorReal * stepImaginary + factorImaginary * stepReal;
        factorReal = nextFactorReal;
      }
    }
  }

  if (inverse) {
    for (let index = 0; index < real.length; index += 1) {
      real[index] /= real.length;
      imaginary[index] /= real.length;
    }
  }
}

function resampleSegment(segment: Float32Array, ratio: number): Float32Array {
  const outputLength = Math.max(2, Math.round(segment.length / ratio));
  const resampled = new Float32Array(outputLength);
  for (let index = 0; index < outputLength; index += 1) {
    const position = Math.min(segment.length - 1, index * ratio);
    const left = Math.floor(position);
    const right = Math.min(segment.length - 1, left + 1);
    const fraction = position - left;
    const leftSample = Number.isFinite(segment[left]) ? segment[left] : 0;
    const rightSample = Number.isFinite(segment[right]) ? segment[right] : 0;
    resampled[index] = leftSample * (1 - fraction) + rightSample * fraction;
  }
  return resampled;
}

function phaseVocoderTimeStretch(input: Float32Array, stretch: number, outputLength: number): Float32Array | null {
  if (input.length < FFT_SIZE || !Number.isFinite(stretch) || stretch <= 0) return null;
  const output = new Float64Array(outputLength + FFT_SIZE + FFT_HOP);
  const normalization = new Float64Array(output.length);
  const previousPhase = new Float64Array(FFT_SIZE / 2 + 1);
  const accumulatedPhase = new Float64Array(FFT_SIZE / 2 + 1);
  const expectedAdvance = new Float64Array(FFT_SIZE / 2 + 1);
  const window = new Float64Array(FFT_SIZE);
  for (let index = 0; index < FFT_SIZE; index += 1) {
    window[index] = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / (FFT_SIZE - 1));
  }
  for (let bin = 0; bin <= FFT_SIZE / 2; bin += 1) expectedAdvance[bin] = (2 * Math.PI * bin * FFT_HOP) / FFT_SIZE;

  const real = new Float64Array(FFT_SIZE);
  const imaginary = new Float64Array(FFT_SIZE);
  let firstFrame = true;
  let frameNumber = 0;
  for (let inputStart = 0; inputStart < input.length; inputStart += FFT_HOP) {
    real.fill(0);
    imaginary.fill(0);
    for (let offset = 0; offset < FFT_SIZE; offset += 1) {
      const sample = inputStart + offset < input.length ? input[inputStart + offset] : 0;
      real[offset] = (Number.isFinite(sample) ? sample : 0) * window[offset];
    }
    transform(real, imaginary, false);

    for (let bin = 0; bin <= FFT_SIZE / 2; bin += 1) {
      const magnitude = Math.hypot(real[bin], imaginary[bin]);
      const phase = Math.atan2(imaginary[bin], real[bin]);
      if (firstFrame) accumulatedPhase[bin] = phase;
      else {
        const phaseDelta = wrapPhase(phase - previousPhase[bin] - expectedAdvance[bin]);
        accumulatedPhase[bin] += (expectedAdvance[bin] + phaseDelta) * stretch;
      }
      previousPhase[bin] = phase;
      real[bin] = magnitude * Math.cos(accumulatedPhase[bin]);
      imaginary[bin] = magnitude * Math.sin(accumulatedPhase[bin]);
    }
    for (let bin = 1; bin < FFT_SIZE / 2; bin += 1) {
      real[FFT_SIZE - bin] = real[bin];
      imaginary[FFT_SIZE - bin] = -imaginary[bin];
    }
    transform(real, imaginary, true);

    const outputStart = Math.round(frameNumber * FFT_HOP * stretch);
    for (let offset = 0; offset < FFT_SIZE && outputStart + offset < output.length; offset += 1) {
      if (outputStart + offset < 0) continue;
      output[outputStart + offset] += real[offset] * window[offset];
      normalization[outputStart + offset] += window[offset] ** 2;
    }
    firstFrame = false;
    frameNumber += 1;
  }

  const result = new Float32Array(outputLength);
  for (let index = 0; index < outputLength; index += 1) {
    const value = normalization[index] > 1e-8 ? output[index] / normalization[index] : 0;
    result[index] = Number.isFinite(value) ? value : 0;
  }
  return result;
}

function simplePitchShiftSegment(segment: Float32Array, ratio: number): Float32Array {
  const shifted = new Float32Array(segment.length);
  for (let index = 0; index < segment.length; index += 1) {
    const position = Math.min(segment.length - 1, index * ratio);
    const left = Math.floor(position);
    const right = Math.min(segment.length - 1, left + 1);
    const fraction = position - left;
    const leftSample = Number.isFinite(segment[left]) ? segment[left] : 0;
    const rightSample = Number.isFinite(segment[right]) ? segment[right] : 0;
    shifted[index] = leftSample * (1 - fraction) + rightSample * fraction;
  }
  return shifted;
}

function pitchShiftSegment(segment: Float32Array, ratio: number): Float32Array {
  if (segment.length < FFT_SIZE * 2 || segment.length > MAX_PHASE_VOCODER_SEGMENT_SAMPLES) {
    return simplePitchShiftSegment(segment, ratio);
  }
  const resampled = resampleSegment(segment, ratio);
  return phaseVocoderTimeStretch(resampled, ratio, segment.length)
    ?? simplePitchShiftSegment(segment, ratio);
}

export function renderCorrectedSamples(samples: Float32Array, sampleRate: number, notes: Note[]): Float32Array {
  const rendered = new Float32Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) rendered[index] = Number.isFinite(samples[index]) ? samples[index] : 0;
  // A bad rate must never turn an otherwise valid source into silent output.
  if (!Number.isInteger(sampleRate) || sampleRate <= 0 || sampleRate > 384_000) return rendered;
  const orderedNotes = notes
    .filter((note) => Number.isFinite(note.startSeconds)
      && Number.isFinite(note.endSeconds)
      && Number.isFinite(note.originalPitchMidi)
      && Number.isFinite(note.targetPitchMidi)
      && note.endSeconds > note.startSeconds)
    .sort((left, right) => left.startSeconds - right.startSeconds);
  for (let noteIndex = 0; noteIndex < orderedNotes.length; noteIndex += 1) {
    const note = orderedNotes[noteIndex];
    const effectiveEndSeconds = Math.min(note.endSeconds, orderedNotes[noteIndex + 1]?.startSeconds ?? note.endSeconds);
    const start = Math.max(0, Math.min(samples.length, Math.floor(note.startSeconds * sampleRate)));
    const end = Math.max(start, Math.min(samples.length, Math.ceil(effectiveEndSeconds * sampleRate)));
    if (end <= start) continue;
    const ratio = Math.max(0.25, Math.min(4, 2 ** ((note.targetPitchMidi - note.originalPitchMidi) / 12)));
    if (!Number.isFinite(ratio) || Math.abs(ratio - 1) < 0.0001) continue;
    // Give the phase vocoder material on both sides of a note so its first
    // analysis frames contain the real transient/phase context. Only the
    // note itself is mixed back, so neighboring notes are not edited.
    const contextSamples = Math.min(
      RENDER_CONTEXT_MAX_SAMPLES,
      Math.max(RENDER_CONTEXT_MIN_SAMPLES, Math.floor(sampleRate * 0.02)),
    );
    const contextStart = Math.max(0, start - contextSamples);
    const contextEnd = Math.min(samples.length, end + contextSamples);
    const shifted = pitchShiftSegment(samples.subarray(contextStart, contextEnd), ratio);
    const fadeSamples = Math.min(Math.floor(sampleRate * 0.012), Math.floor((end - start) / 4));
    for (let index = start; index < end; index += 1) {
      const local = index - start;
      const fadeIn = fadeSamples > 0 ? Math.min(1, (local + 1) / fadeSamples) : 1;
      const fadeOut = fadeSamples > 0 ? Math.min(1, (end - index) / fadeSamples) : 1;
      const blend = Math.min(fadeIn, fadeOut);
      const original = Number.isFinite(samples[index]) ? samples[index] : 0;
      const correctedIndex = index - contextStart;
      const corrected = Number.isFinite(shifted[correctedIndex]) ? shifted[correctedIndex] : original;
      rendered[index] = original * (1 - blend) + corrected * blend;
    }
  }
  return rendered;
}

export function createMonoAudioBuffer(context: BaseAudioContext, samples: Float32Array, sampleRate: number): AudioBuffer {
  const buffer = context.createBuffer(1, samples.length, sampleRate);
  const copy = new Float32Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) copy[index] = Number.isFinite(samples[index]) ? samples[index] : 0;
  buffer.copyToChannel(copy, 0);
  return buffer;
}
