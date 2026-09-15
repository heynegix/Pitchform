import type { Note, PitchFrame } from '../types';

export interface AnalysisOptions {
  frameSize?: number;
  hopSize?: number;
  minFrequency?: number;
  maxFrequency?: number;
  rmsThreshold?: number;
}

const DEFAULTS: Required<AnalysisOptions> = {
  frameSize: 2048,
  hopSize: 512,
  minFrequency: 70,
  maxFrequency: 1000,
  rmsThreshold: 0.008,
};

export function frequencyToMidi(frequencyHz: number): number {
  if (!Number.isFinite(frequencyHz) || frequencyHz <= 0) return Number.NaN;
  return 69 + 12 * Math.log2(frequencyHz / 440);
}

export function midiToFrequency(midi: number): number {
  if (!Number.isFinite(midi)) return Number.NaN;
  return 440 * 2 ** ((midi - 69) / 12);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function parabolicPeak(left: number, middle: number, right: number): number {
  const denominator = left - 2 * middle + right;
  if (Math.abs(denominator) < 1e-12) return 0;
  return clamp(0.5 * (left - right) / denominator, -0.5, 0.5);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function resolveOptions(options: AnalysisOptions): Required<AnalysisOptions> {
  const positiveInteger = (value: number | undefined, fallback: number, minimum: number, maximum: number) => {
    if (!Number.isFinite(value)) return fallback;
    return Math.min(maximum, Math.max(minimum, Math.round(value as number)));
  };
  const frameSize = positiveInteger(options.frameSize, DEFAULTS.frameSize, 256, 8192);
  const hopSize = positiveInteger(options.hopSize, DEFAULTS.hopSize, 32, frameSize);
  const minFrequency = Number.isFinite(options.minFrequency)
    ? Math.min(2_000, Math.max(20, options.minFrequency as number))
    : DEFAULTS.minFrequency;
  const maxFrequency = Number.isFinite(options.maxFrequency)
    ? Math.min(4_000, Math.max(minFrequency + 1, options.maxFrequency as number))
    : DEFAULTS.maxFrequency;
  const rmsThreshold = Number.isFinite(options.rmsThreshold)
    ? Math.min(1, Math.max(0, options.rmsThreshold as number))
    : DEFAULTS.rmsThreshold;
  return { frameSize, hopSize, minFrequency, maxFrequency, rmsThreshold };
}

function analyzeFrame(
  samples: Float32Array,
  start: number,
  sampleRate: number,
  options: Required<AnalysisOptions>,
): { frequencyHz: number | null; confidence: number; voiced: boolean } {
  const available = Math.min(options.frameSize, samples.length - start);
  if (available < Math.max(64, options.frameSize / 4)) {
    return { frequencyHz: null, confidence: 0, voiced: false };
  }

  let energy = 0;
  for (let index = 0; index < available; index += 1) {
    energy += samples[start + index] ** 2;
  }
  const rms = Math.sqrt(energy / available);
  if (!Number.isFinite(rms) || rms < options.rmsThreshold) {
    return { frequencyHz: null, confidence: 0, voiced: false };
  }

  const minTau = Math.max(2, Math.floor(sampleRate / options.maxFrequency));
  const maxTau = Math.min(Math.floor(sampleRate / options.minFrequency), available - 2);
  if (maxTau <= minTau) return { frequencyHz: null, confidence: 0, voiced: false };

  const difference = new Float64Array(maxTau + 1);
  for (let tau = 1; tau <= maxTau; tau += 1) {
    let sum = 0;
    const limit = available - tau;
    for (let index = 0; index < limit; index += 1) {
      const delta = samples[start + index] - samples[start + index + tau];
      sum += delta * delta;
    }
    difference[tau] = sum / Math.max(1, limit);
  }

  let signalPower = 0;
  for (let index = 0; index < available; index += 1) signalPower += samples[start + index] ** 2;
  const normalized = new Float64Array(maxTau + 1);
  let running = 0;
  let bestTau = minTau;
  let bestValue = Number.POSITIVE_INFINITY;
  for (let tau = 1; tau <= maxTau; tau += 1) {
    running += difference[tau];
    normalized[tau] = running > 0 ? difference[tau] * tau / running : 1;
    if (tau >= minTau && normalized[tau] < bestValue) {
      bestValue = normalized[tau];
      bestTau = tau;
    }
  }

  const threshold = 0.002;
  for (let tau = minTau; tau <= maxTau; tau += 1) {
    if (normalized[tau] < threshold) {
      bestTau = tau;
      bestValue = normalized[tau];
      break;
    }
  }
  const offset = bestTau > minTau && bestTau < maxTau
    ? parabolicPeak(normalized[bestTau - 1], normalized[bestTau], normalized[bestTau + 1])
    : 0;
  const period = bestTau + offset;
  const frequencyHz = sampleRate / period;
  const confidence = clamp(1 - bestValue, 0, 1) * clamp(rms / 0.08, 0.35, 1);
  const voiced = Number.isFinite(frequencyHz) && confidence >= 0.35 && signalPower > 0;
  return {
    frequencyHz: voiced ? frequencyHz : null,
    confidence: voiced ? confidence : 0,
    voiced,
  };
}

export function analyzeMonophonic(
  samples: Float32Array,
  sampleRate: number,
  options: AnalysisOptions = {},
): PitchFrame[] {
  const resolved = resolveOptions(options);
  if (samples.length === 0 || !Number.isFinite(sampleRate) || sampleRate <= 0 || sampleRate > 384_000) return [];
  const cleanSamples = new Float32Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    cleanSamples[index] = Number.isFinite(samples[index]) ? samples[index] : 0;
  }
  const frames: PitchFrame[] = [];
  const durationSeconds = cleanSamples.length / sampleRate;
  for (let start = 0; start < cleanSamples.length; start += resolved.hopSize) {
    const result = analyzeFrame(cleanSamples, start, sampleRate, resolved);
    frames.push({
      timeSeconds: Math.min(durationSeconds, (start + resolved.frameSize / 2) / sampleRate),
      frequencyHz: result.frequencyHz,
      midi: result.frequencyHz === null ? null : frequencyToMidi(result.frequencyHz),
      confidence: result.confidence,
      voiced: result.voiced,
    });
  }

  // Median smoothing removes isolated octave or autocorrelation errors without erasing note changes.
  return frames.map((frame, index) => {
    if (!frame.voiced || frame.midi === null) return frame;
    const neighbors = frames
      .slice(Math.max(0, index - 1), Math.min(frames.length, index + 2))
      .filter((candidate) => candidate.voiced && candidate.midi !== null)
      .map((candidate) => candidate.midi as number);
    const smoothedMidi = median(neighbors);
    return {
      ...frame,
      midi: smoothedMidi,
      frequencyHz: midiToFrequency(smoothedMidi),
    };
  });
}

export interface SegmentationOptions {
  minNoteSeconds?: number;
  maxGapSeconds?: number;
  jumpSemitones?: number;
  minConfidence?: number;
}

const SEGMENTATION_DEFAULTS: Required<SegmentationOptions> = {
  minNoteSeconds: 0.08,
  maxGapSeconds: 0.14,
  jumpSemitones: 2.5,
  minConfidence: 0.35,
};

export function segmentNotes(
  frames: PitchFrame[],
  durationSeconds: number,
  options: SegmentationOptions = {},
): Note[] {
  const positive = (value: number | undefined, fallback: number, minimum: number, maximum: number) => Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, value as number))
    : fallback;
  const resolved = {
    minNoteSeconds: positive(options.minNoteSeconds, SEGMENTATION_DEFAULTS.minNoteSeconds, 0.01, 10),
    maxGapSeconds: positive(options.maxGapSeconds, SEGMENTATION_DEFAULTS.maxGapSeconds, 0.01, 5),
    jumpSemitones: positive(options.jumpSemitones, SEGMENTATION_DEFAULTS.jumpSemitones, 0.1, 24),
    minConfidence: positive(options.minConfidence, SEGMENTATION_DEFAULTS.minConfidence, 0, 1),
  };
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return [];
  const orderedFrames = frames
    .filter((frame) => Number.isFinite(frame.timeSeconds) && frame.timeSeconds >= 0 && frame.timeSeconds <= durationSeconds)
    .sort((left, right) => left.timeSeconds - right.timeSeconds);
  if (orderedFrames.length === 0) return [];
  const frameDeltas: number[] = [];
  for (let index = 1; index < Math.min(orderedFrames.length, 32); index += 1) {
    const delta = orderedFrames[index].timeSeconds - orderedFrames[index - 1].timeSeconds;
    if (delta > 0) frameDeltas.push(delta);
  }
  const frameStep = frameDeltas.length > 0 ? Math.max(0.001, median(frameDeltas)) : 0.01;
  const halfStep = frameStep / 2;
  const notes: Note[] = [];
  let current: PitchFrame[] = [];

  const flush = () => {
    if (current.length === 0) return;
    const first = current[0];
    const last = current[current.length - 1];
    const pitches = current.map((frame) => frame.midi as number);
    const startSeconds = Math.min(durationSeconds, Math.max(0, first.timeSeconds - halfStep));
    const endSeconds = Math.min(durationSeconds, Math.max(startSeconds, last.timeSeconds + halfStep));
    if (endSeconds - startSeconds >= resolved.minNoteSeconds) {
      const originalPitchMidi = median(pitches);
      const confidence = clamp(current.reduce((sum, frame) => sum + frame.confidence, 0) / current.length, 0, 1);
      notes.push({
        id: `note-${notes.length + 1}`,
        startSeconds,
        endSeconds,
        originalPitchMidi,
        targetPitchMidi: Math.round(originalPitchMidi),
        centsOffset: (originalPitchMidi - Math.round(originalPitchMidi)) * 100,
        confidence,
      });
    }
    current = [];
  };

  for (const frame of orderedFrames) {
    const usable = frame.voiced
      && frame.midi !== null
      && Number.isFinite(frame.midi)
      && Number.isFinite(frame.confidence)
      && frame.confidence >= resolved.minConfidence;
    if (!usable) {
      if (current.length > 0 && frame.timeSeconds - current[current.length - 1].timeSeconds > resolved.maxGapSeconds) flush();
      continue;
    }
    const previous = current[current.length - 1];
    if (previous && previous.midi !== null && frame.midi !== null && Math.abs(frame.midi - previous.midi) > resolved.jumpSemitones) flush();
    current.push(frame);
  }
  flush();
  return notes;
}
