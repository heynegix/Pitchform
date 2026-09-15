import { renderCorrectedSamples } from './lib/audio';
import type { Note } from './types';

interface RenderRequest {
  samples: Float32Array;
  sampleRate: number;
  notes: Note[];
}

const workerScope = self as unknown as { postMessage: (message: unknown, transfer?: Transferable[]) => void };

self.onmessage = (event: MessageEvent<RenderRequest>) => {
  try {
    const rendered = renderCorrectedSamples(event.data.samples, event.data.sampleRate, event.data.notes);
    workerScope.postMessage({ samples: rendered }, [rendered.buffer as ArrayBuffer]);
  } catch (error) {
    workerScope.postMessage({ error: error instanceof Error ? error.message : 'Render failed.' });
  }
};

export {};
