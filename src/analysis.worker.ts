import { analyzeMonophonic, segmentNotes } from './lib/analysis';

interface WorkerRequest {
  samples: Float32Array;
  sampleRate: number;
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  try {
    const { samples, sampleRate } = event.data;
    const frames = analyzeMonophonic(samples, sampleRate);
    const durationSeconds = samples.length / sampleRate;
    const notes = segmentNotes(frames, durationSeconds);
    self.postMessage({ frames, notes });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : 'Analysis failed.' });
  }
};

export {};

