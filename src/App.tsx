import { useCallback, useEffect, useRef, useState } from 'react';
import { EditorCanvas } from './components/EditorCanvas';
import { audioBufferToMono, encodeWav, renderCorrectedSamples, validateDecodedAudioBuffer } from './lib/audio';
import { analyzeMonophonic, segmentNotes } from './lib/analysis';
import { isNotePitchEdited, nudgeNotePitch, noteStateSignature, resetNotePitch, updateNotePitch } from './lib/editor';
import { base64ToBytes, createPitchformProject, isPitchformProject, MAX_PROJECT_FILE_BYTES, projectToJson, sha256Hex } from './lib/project';
import type { AudioSourceMetadata, EditorState, Note, PitchFrame, PitchformProject, TimeRange } from './types';
import './styles.css';

interface LoadedSource {
  file: File;
  buffer: AudioBuffer;
  samples: Float32Array;
  frames: PitchFrame[];
  metadata: AudioSourceMetadata;
}

const MAX_AUDIO_FILE_BYTES = 256_000_000;

function cloneNotes(notes: Note[]): Note[] {
  return notes.map((note) => ({ ...note }));
}

function notesEqual(left: Note[], right: Note[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((note, index) => {
    const other = right[index];
    return note.id === other.id
      && note.startSeconds === other.startSeconds
      && note.endSeconds === other.endSeconds
      && note.originalPitchMidi === other.originalPitchMidi
      && note.targetPitchMidi === other.targetPitchMidi
      && note.centsOffset === other.centsOffset
      && note.confidence === other.confidence;
  });
}

function documentSignature(notes: Note[], zoom: number, snapToSemitone: boolean, loopSelection: TimeRange | null): string {
  const loop = loopSelection ? `${loopSelection.startSeconds}:${loopSelection.endSeconds}` : 'none';
  return `${noteStateSignature(notes)}|zoom:${zoom}|snap:${snapToSemitone}|loop:${loop}`;
}

function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return '0:00';
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${minutes}:${remainder}`;
}

function outputBaseName(name: string): string {
  const withoutExtension = name.replace(/\.[^/.]+$/, '');
  const safe = Array.from(withoutExtension, (character) => {
    const code = character.charCodeAt(0);
    return code < 32 || '\\/:*?"<>|'.includes(character) ? '_' : character;
  }).join('');
  return safe.trim() || 'pitchform';
}

async function decodeAudioFile(file: File): Promise<{ buffer: AudioBuffer; raw: ArrayBuffer }> {
  const raw = await file.arrayBuffer();
  const Context = window.AudioContext ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Context) throw new Error('Audio playback is unavailable in this environment.');
  const context = new Context();
  try {
    const buffer = await context.decodeAudioData(raw.slice(0));
    validateDecodedAudioBuffer(buffer);
    return { buffer, raw };
  } finally {
    await context.close();
  }
}

function isAbortError(error: unknown): boolean {
  return (error instanceof DOMException && error.name === 'AbortError')
    || (error instanceof Error && error.name === 'AbortError');
}

async function analyzeInWorker(
  samples: Float32Array,
  sampleRate: number,
  signal?: AbortSignal,
  onProgress?: (progress: number) => void,
): Promise<{ frames: PitchFrame[]; notes: Note[] }> {
  if (signal?.aborted) throw new DOMException('Analysis cancelled.', 'AbortError');
  if (typeof Worker === 'undefined') {
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    if (signal?.aborted) throw new DOMException('Analysis cancelled.', 'AbortError');
    const frames = analyzeMonophonic(samples, sampleRate, { onProgress });
    return { frames, notes: segmentNotes(frames, samples.length / sampleRate) };
  }
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('./analysis.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      void new Promise<void>((resolveTick) => window.setTimeout(resolveTick, 0)).then(() => {
        if (signal?.aborted) {
          reject(new DOMException('Analysis cancelled.', 'AbortError'));
          return;
        }
        try {
          const frames = analyzeMonophonic(samples, sampleRate, { onProgress });
          resolve({ frames, notes: segmentNotes(frames, samples.length / sampleRate) });
        } catch (fallbackError) {
          reject(fallbackError instanceof Error ? fallbackError : new Error('Pitch analysis failed.'));
        }
      });
      return;
    }
    let settled = false;
    const cancel = () => {
      if (settled) return;
      settled = true;
      worker.terminate();
      reject(new DOMException('Analysis cancelled.', 'AbortError'));
    };
    signal?.addEventListener('abort', cancel, { once: true });
    worker.onmessage = (event: MessageEvent<{ frames?: PitchFrame[]; notes?: Note[]; error?: string; progress?: number }>) => {
      if (settled) return;
      if (typeof event.data?.progress === 'number') {
        onProgress?.(Math.max(0, Math.min(1, event.data.progress)));
        return;
      }
      settled = true;
      signal?.removeEventListener('abort', cancel);
      worker.terminate();
      const data = event.data;
      if (!data || data.error || !data.frames || !data.notes) reject(new Error(data?.error ?? 'Analysis failed.'));
      else resolve({ frames: data.frames, notes: data.notes });
    };
    worker.onerror = () => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', cancel);
      worker.terminate();
      reject(new Error('Pitch analysis worker failed.'));
    };
    // Transfer a copy: the source samples are still needed for playback,
    // rendering, export, and project embedding after analysis completes.
    const workerSamples = samples.slice();
    try {
      worker.postMessage({ samples: workerSamples, sampleRate }, [workerSamples.buffer]);
    } catch (postError) {
      if (!settled) {
        settled = true;
        signal?.removeEventListener('abort', cancel);
        worker.terminate();
        reject(postError instanceof Error ? postError : new Error('Could not start pitch analysis.'));
      }
    }
  });
}

async function renderInWorker(samples: Float32Array, sampleRate: number, notes: Note[], signal?: AbortSignal): Promise<Float32Array> {
  if (signal?.aborted) throw new DOMException('Render cancelled.', 'AbortError');
  if (typeof Worker === 'undefined') {
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    if (signal?.aborted) throw new DOMException('Render cancelled.', 'AbortError');
    return renderCorrectedSamples(samples, sampleRate, notes);
  }
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('./render.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      void new Promise<void>((resolveTick) => window.setTimeout(resolveTick, 0)).then(() => {
        if (signal?.aborted) {
          reject(new DOMException('Render cancelled.', 'AbortError'));
          return;
        }
        try {
          resolve(renderCorrectedSamples(samples, sampleRate, notes));
        } catch (fallbackError) {
          reject(fallbackError instanceof Error ? fallbackError : new Error('Correction rendering failed.'));
        }
      });
      return;
    }
    let settled = false;
    const cancel = () => {
      if (settled) return;
      settled = true;
      worker.terminate();
      reject(new DOMException('Render cancelled.', 'AbortError'));
    };
    signal?.addEventListener('abort', cancel, { once: true });
    worker.onmessage = (event: MessageEvent<{ samples?: Float32Array; error?: string }>) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', cancel);
      worker.terminate();
      const data = event.data;
      if (!data || data.error || !data.samples) reject(new Error(data?.error ?? 'Correction renderer failed.'));
      else resolve(data.samples);
    };
    worker.onerror = () => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', cancel);
      worker.terminate();
      reject(new Error('Correction renderer failed.'));
    };
    const workerSamples = samples.slice();
    try {
      worker.postMessage({ samples: workerSamples, sampleRate, notes }, [workerSamples.buffer]);
    } catch (postError) {
      if (!settled) {
        settled = true;
        signal?.removeEventListener('abort', cancel);
        worker.terminate();
        reject(postError instanceof Error ? postError : new Error('Could not start correction rendering.'));
      }
    }
  });
}

export default function App() {
  const audioRef = useRef<HTMLAudioElement>(null);
  const audioInputRef = useRef<HTMLInputElement>(null);
  const projectInputRef = useRef<HTMLInputElement>(null);
  const dragStartNotes = useRef<Note[] | null>(null);
  const history = useRef<Note[][]>([]);
  const future = useRef<Note[][]>([]);
  const latestNotes = useRef<Note[]>([]);
  const operationId = useRef(0);
  const analysisAbort = useRef<AbortController | null>(null);
  const [source, setSource] = useState<LoadedSource | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [snapToSemitone, setSnapToSemitone] = useState(true);
  const [previewMode, setPreviewMode] = useState<'corrected' | 'original'>('corrected');
  const [originalUrl, setOriginalUrl] = useState<string | null>(null);
  const [correctedUrl, setCorrectedUrl] = useState<string | null>(null);
  const [correctedSamples, setCorrectedSamples] = useState<Float32Array | null>(null);
  const [playheadSeconds, setPlayheadSeconds] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [loopEnabled, setLoopEnabled] = useState(false);
  const [status, setStatus] = useState('Drop a vocal to begin');
  const [error, setError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [isRendering, setIsRendering] = useState(false);
  const [loopSelection, setLoopSelection] = useState<TimeRange | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const savedDocumentSignature = useRef('');
  const [, forceHistoryRender] = useState(0);
  latestNotes.current = notes;
  const selectedNote = notes.find((note) => note.id === selectedNoteId) ?? null;
  const durationSeconds = source?.buffer.duration ?? 0;
  const loopRange = loopSelection
    ? { start: loopSelection.startSeconds, end: loopSelection.endSeconds }
    : selectedNote ? { start: selectedNote.startSeconds, end: selectedNote.endSeconds } : { start: 0, end: durationSeconds };
  const activeUrl = previewMode === 'original' ? originalUrl : correctedUrl ?? originalUrl;

  const updateDirtyState = (
    nextNotes: Note[],
    nextZoom = zoom,
    nextSnapToSemitone = snapToSemitone,
    nextLoopSelection = loopSelection,
  ) => {
    setIsDirty(documentSignature(nextNotes, nextZoom, nextSnapToSemitone, nextLoopSelection) !== savedDocumentSignature.current);
  };

  useEffect(() => {
    if (!isDirty) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warnBeforeUnload);
    return () => window.removeEventListener('beforeunload', warnBeforeUnload);
  }, [isDirty]);

  useEffect(() => {
    if (!source) {
      setOriginalUrl(null);
      return;
    }
    const url = URL.createObjectURL(source.file);
    setOriginalUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [source]);

  useEffect(() => {
    if (!source) {
      setCorrectedSamples(null);
      setIsRendering(false);
      return;
    }
    const controller = new AbortController();
    setCorrectedSamples(null);
    setIsRendering(true);
    const timer = window.setTimeout(() => {
      void renderInWorker(source.samples, source.buffer.sampleRate, notes, controller.signal)
        .then((rendered) => {
          if (!controller.signal.aborted) setCorrectedSamples(rendered);
        })
        .catch((renderError: unknown) => {
          if (!controller.signal.aborted && !isAbortError(renderError)) {
            setError(renderError instanceof Error ? renderError.message : 'Could not render the corrected preview.');
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) setIsRendering(false);
        });
    }, 80);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [notes, source]);

  useEffect(() => {
    if (!correctedSamples || !source) {
      setCorrectedUrl(null);
      return;
    }
    try {
      const wav = encodeWav(correctedSamples, source.buffer.sampleRate);
      const url = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
      setCorrectedUrl(url);
      return () => URL.revokeObjectURL(url);
    } catch (renderError) {
      setCorrectedUrl(null);
      setError(renderError instanceof Error ? renderError.message : 'Could not create the corrected preview.');
      return undefined;
    }
  }, [correctedSamples, source]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !activeUrl) return;
    const time = audio.currentTime;
    const shouldResume = !audio.paused;
    audio.src = activeUrl;
    audio.load();
    const restore = () => {
      const duration = Number.isFinite(audio.duration) && audio.duration >= 0 ? audio.duration : undefined;
      const target = Number.isFinite(time) ? Math.max(0, duration === undefined ? time : Math.min(time, duration)) : 0;
      try {
        audio.currentTime = target;
      } catch {
        setPlayheadSeconds(0);
      }
      if (shouldResume) void audio.play().catch(() => setIsPlaying(false));
    };
    audio.addEventListener('loadedmetadata', restore, { once: true });
    return () => audio.removeEventListener('loadedmetadata', restore);
  }, [activeUrl]);

  const loadAudio = useCallback(async (file: File) => {
    if (isDirty && !window.confirm('Discard unsaved changes and open another audio file?')) return;
    operationId.current += 1;
    const thisOperation = operationId.current;
    analysisAbort.current?.abort();
    const controller = new AbortController();
    analysisAbort.current = controller;
    setError(null);
    setIsBusy(true);
    audioRef.current?.pause();
    if (audioRef.current) {
      try {
        audioRef.current.currentTime = 0;
      } catch {
        // The media element may not have a source yet.
      }
    }
    setIsPlaying(false);
    setLoopEnabled(false);
    setStatus(`Loading ${file.name}…`);
    try {
      if (file.size > MAX_AUDIO_FILE_BYTES) throw new Error('This audio file is too large to open safely (maximum 256 MB).');
      const { buffer, raw } = await decodeAudioFile(file);
      if (controller.signal.aborted || thisOperation !== operationId.current) return;
      const samples = audioBufferToMono(buffer);
      const fingerprint = await sha256Hex(raw);
      if (controller.signal.aborted || thisOperation !== operationId.current) return;
      setStatus('Listening for notes…');
      const analysis = await analyzeInWorker(samples, buffer.sampleRate, controller.signal, (progress) => {
        if (thisOperation === operationId.current) setStatus(`Listening for notes… ${Math.round(progress * 100)}%`);
      });
      if (controller.signal.aborted || thisOperation !== operationId.current) return;
      setSource({
        file,
        buffer,
        samples,
        frames: analysis.frames,
        metadata: { name: file.name, size: file.size, lastModified: file.lastModified, sha256: fingerprint },
      });
      setOriginalUrl(null);
      setCorrectedSamples(null);
      setCorrectedUrl(null);
      setNotes(analysis.notes);
      latestNotes.current = analysis.notes;
      savedDocumentSignature.current = documentSignature(analysis.notes, 1, true, null);
      setIsDirty(false);
      setSelectedNoteId(analysis.notes[0]?.id ?? null);
      setZoom(1);
      setScrollLeft(0);
      setSnapToSemitone(true);
      dragStartNotes.current = null;
      history.current = [];
      future.current = [];
      forceHistoryRender((value) => value + 1);
      setPlayheadSeconds(0);
      setLoopSelection(null);
      setPreviewMode('corrected');
      setStatus(`${analysis.notes.length} notes detected · local only`);
    } catch (loadError) {
      if (isAbortError(loadError) || thisOperation !== operationId.current) return;
      setError(loadError instanceof Error ? loadError.message : 'Could not open that audio file.');
      setStatus('Could not load audio');
    } finally {
      if (thisOperation === operationId.current) {
        setIsBusy(false);
        if (analysisAbort.current === controller) analysisAbort.current = null;
      }
    }
  }, [isDirty]);

  const openProject = useCallback(async (project: PitchformProject, expectedOperationId?: number) => {
    const bytes = base64ToBytes(project.audioWavBase64);
    const fileBytes = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const file = new File([fileBytes], project.sourceAudio.name, { type: 'audio/wav', lastModified: project.sourceAudio.lastModified });
    const { buffer } = await decodeAudioFile(file);
    if (expectedOperationId !== undefined && expectedOperationId !== operationId.current) return;
    const durationTolerance = Math.max(0.001, 2 / buffer.sampleRate);
    if (Math.abs(buffer.duration - project.analysis.durationSeconds) > durationTolerance) {
      throw new Error('The project audio does not match its analysis duration.');
    }
    const samples = audioBufferToMono(buffer);
    setOriginalUrl(null);
    setCorrectedSamples(null);
    setCorrectedUrl(null);
    const projectNotes = cloneNotes(project.edits.notes);
    setSource({ file, buffer, samples, frames: project.analysis.frames, metadata: { ...project.sourceAudio } });
    setNotes(projectNotes);
    latestNotes.current = projectNotes;
    setSelectedNoteId(projectNotes[0]?.id ?? null);
    setZoom(project.editorState.zoom);
    setScrollLeft(project.editorState.scrollLeft);
    setSnapToSemitone(project.editorState.snapToSemitone);
    dragStartNotes.current = null;
    history.current = [];
    future.current = [];
    forceHistoryRender((value) => value + 1);
    setPlayheadSeconds(0);
    setLoopEnabled(false);
    const savedLoopStart = project.editorState.loopStartSeconds;
    const savedLoopEnd = project.editorState.loopEndSeconds;
    const restoredLoopStart = typeof savedLoopStart === 'number'
      ? Math.max(0, Math.min(buffer.duration, savedLoopStart))
      : null;
    const restoredLoopEnd = typeof savedLoopEnd === 'number'
      ? Math.max(0, Math.min(buffer.duration, savedLoopEnd))
      : null;
    const restoredLoopSelection = restoredLoopStart !== null && restoredLoopEnd !== null && restoredLoopEnd > restoredLoopStart
      ? { startSeconds: restoredLoopStart, endSeconds: restoredLoopEnd }
      : null;
    savedDocumentSignature.current = documentSignature(
      projectNotes,
      project.editorState.zoom,
      project.editorState.snapToSemitone,
      restoredLoopSelection,
    );
    setIsDirty(false);
    setLoopSelection(restoredLoopSelection);
    setPreviewMode('corrected');
    setStatus(`Opened ${project.sourceAudio.name}`);
  }, []);

  const handleProjectFile = async (file: File) => {
    if (isDirty && !window.confirm('Discard unsaved changes and open this project?')) return;
    operationId.current += 1;
    const thisOperation = operationId.current;
    analysisAbort.current?.abort();
    setError(null);
    setIsBusy(true);
    audioRef.current?.pause();
    if (audioRef.current) {
      try {
        audioRef.current.currentTime = 0;
      } catch {
        // The media element may not have a source yet.
      }
    }
    setIsPlaying(false);
    setStatus(`Opening ${file.name}…`);
    try {
      if (file.size > MAX_PROJECT_FILE_BYTES) throw new Error('This project file is too large to open safely.');
      const value: unknown = JSON.parse(await file.text());
      if (!isPitchformProject(value)) throw new Error('This is not a valid .pitchform project.');
      if (thisOperation !== operationId.current) return;
      await openProject(value, thisOperation);
      if (thisOperation !== operationId.current) return;
    } catch (openError) {
      if (thisOperation !== operationId.current) return;
      setError(openError instanceof Error ? openError.message : 'Could not open the project.');
      setStatus('Could not open project');
    } finally {
      if (thisOperation === operationId.current) setIsBusy(false);
    }
  };

  const changeNotePitch = (noteId: string, pitch: number, fine: boolean) => {
    const nextNotes = latestNotes.current.map((note) => note.id === noteId ? updateNotePitch(note, pitch, fine) : note);
    latestNotes.current = nextNotes;
    setNotes(nextNotes);
  };

  const beginNoteEdit = () => {
    if (!dragStartNotes.current) dragStartNotes.current = cloneNotes(notes);
  };

  const commitNoteEdit = () => {
    const before = dragStartNotes.current;
    dragStartNotes.current = null;
    if (!before) return;
    if (notesEqual(before, latestNotes.current)) return;
    history.current.push(before);
    future.current = [];
    updateDirtyState(latestNotes.current);
    forceHistoryRender((value) => value + 1);
    setStatus('Note edit ready to preview');
  };

  const undo = () => {
    const previous = history.current.pop();
    if (!previous) return;
    future.current.push(cloneNotes(latestNotes.current));
    const nextNotes = cloneNotes(previous);
    latestNotes.current = nextNotes;
    setNotes(nextNotes);
    updateDirtyState(nextNotes);
    forceHistoryRender((value) => value + 1);
    setStatus('Undid last edit');
  };

  const redo = () => {
    const next = future.current.pop();
    if (!next) return;
    history.current.push(cloneNotes(latestNotes.current));
    const nextNotes = cloneNotes(next);
    latestNotes.current = nextNotes;
    setNotes(nextNotes);
    updateDirtyState(nextNotes);
    forceHistoryRender((value) => value + 1);
    setStatus('Redid last edit');
  };

  const nudgeSelectedNote = (direction: -1 | 1, fine: boolean) => {
    if (!selectedNoteId) return;
    const before = latestNotes.current;
    const selected = before.find((note) => note.id === selectedNoteId);
    if (!selected) return;
    const updated = nudgeNotePitch(selected, direction, fine);
    if (updated.targetPitchMidi === selected.targetPitchMidi) return;
    history.current.push(cloneNotes(before));
    future.current = [];
    const nextNotes = before.map((note) => note.id === selectedNoteId ? updated : note);
    latestNotes.current = nextNotes;
    setNotes(nextNotes);
    updateDirtyState(nextNotes);
    forceHistoryRender((value) => value + 1);
    setStatus('Note nudged');
  };

  const resetSelectedNote = () => {
    if (!selectedNoteId) return;
    const before = latestNotes.current;
    const selected = before.find((note) => note.id === selectedNoteId);
    if (!selected || !isNotePitchEdited(selected)) return;
    const nextNotes = before.map((note) => note.id === selectedNoteId ? resetNotePitch(note) : note);
    history.current.push(cloneNotes(before));
    future.current = [];
    latestNotes.current = nextNotes;
    setNotes(nextNotes);
    updateDirtyState(nextNotes);
    forceHistoryRender((value) => value + 1);
    setStatus('Selected note reset');
  };

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio || !activeUrl) return;
    if (audio.paused) {
      if (loopEnabled && loopRange.end > loopRange.start
        && (audio.currentTime < loopRange.start || audio.currentTime >= loopRange.end)) {
        seekTo(loopRange.start);
      }
      void audio.play().then(() => setIsPlaying(true)).catch(() => setError('Playback was blocked by the browser.'));
    }
    else audio.pause();
  };

  const stopPlayback = () => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.pause();
    seekTo(0);
  };

  const toggleLoop = () => {
    if (loopEnabled) {
      setLoopEnabled(false);
      return;
    }
    if (loopRange.end <= loopRange.start) {
      setError('Select a loop range first. Alt-drag across the timeline.');
      return;
    }
    seekTo(loopRange.start);
    setLoopEnabled(true);
  };

  const seekTo = (seconds: number) => {
    const audio = audioRef.current;
    if (!audio || durationSeconds <= 0) return;
    const target = Number.isFinite(seconds) ? Math.max(0, Math.min(durationSeconds, seconds)) : 0;
    try {
      audio.currentTime = target;
      setPlayheadSeconds(target);
    } catch {
      setError('Could not seek in the current audio.');
    }
  };

  const handleSaveProject = () => {
    if (!source) return;
    try {
      const editorState: EditorState = {
        zoom,
        scrollLeft,
        snapToSemitone,
        loopStartSeconds: loopSelection?.startSeconds ?? null,
        loopEndSeconds: loopSelection?.endSeconds ?? null,
      };
      const metadata: AudioSourceMetadata = { ...source.metadata };
      const project = createPitchformProject(metadata, source.buffer.sampleRate, durationSeconds, source.samples, source.frames, notes, editorState);
      downloadBlob(new Blob([projectToJson(project)], { type: 'application/json' }), `${outputBaseName(source.file.name)}.pitchform`);
      savedDocumentSignature.current = documentSignature(notes, zoom, snapToSemitone, loopSelection);
      setIsDirty(false);
      setStatus('Project saved offline');
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save the project.');
    }
  };

  const handleExport = () => {
    if (!source || !correctedSamples) return;
    try {
      downloadBlob(new Blob([encodeWav(correctedSamples, source.buffer.sampleRate)], { type: 'audio/wav' }), `${outputBaseName(source.file.name)}-pitchform.wav`);
      setStatus('Corrected WAV exported');
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : 'Could not export the corrected WAV.');
    }
  };

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const file = event.dataTransfer.files[0];
    if (!file) return;
    if (file.name.toLowerCase().endsWith('.pitchform') || file.type === 'application/json') void handleProjectFile(file);
    else void loadAudio(file);
  };

  const onTimeUpdate = () => {
    const audio = audioRef.current;
    if (!audio) return;
    const currentTime = Number.isFinite(audio.currentTime) ? Math.max(0, Math.min(durationSeconds, audio.currentTime)) : 0;
    setPlayheadSeconds(currentTime);
    if (loopEnabled && loopRange.end > loopRange.start && currentTime >= loopRange.end) {
      seekTo(loopRange.start);
      void audio.play().catch(() => setIsPlaying(false));
    }
  };

  const onEnded = () => {
    const audio = audioRef.current;
    if (loopEnabled && audio && loopRange.end > loopRange.start) {
      seekTo(loopRange.start);
      void audio.play().catch(() => setIsPlaying(false));
      return;
    }
    setIsPlaying(false);
  };

  const handleGlobalKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement | null;
    const tagName = target?.tagName;
    const isTextEntry = tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT';
    const isButton = tagName === 'BUTTON';
    if (isTextEntry || isButton) return;
    const modifier = event.ctrlKey || event.metaKey;
    if (modifier && event.key.toLowerCase() === 's') {
      event.preventDefault();
      if (source && !isBusy && !isRendering) handleSaveProject();
      return;
    }
    if (modifier && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (event.shiftKey) redo(); else undo();
      return;
    }
    if (modifier && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      redo();
      return;
    }
    if (!source || isBusy) return;
    if (event.key === ' ') {
      event.preventDefault();
      togglePlay();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      nudgeSelectedNote(1, event.shiftKey);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      nudgeSelectedNote(-1, event.shiftKey);
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      if (notes.length === 0) return;
      event.preventDefault();
      const currentIndex = selectedNoteId ? notes.findIndex((note) => note.id === selectedNoteId) : -1;
      const nextIndex = event.key === 'ArrowRight'
        ? Math.min(notes.length - 1, currentIndex + 1)
        : Math.max(0, currentIndex - 1);
      const nextNote = notes[nextIndex];
      if (nextNote) {
        setSelectedNoteId(nextNote.id);
        seekTo(nextNote.startSeconds);
      }
    } else if (event.key.toLowerCase() === 'r') {
      event.preventDefault();
      resetSelectedNote();
    }
  };

  return (
    <div className="app-shell" onKeyDown={handleGlobalKeyDown} onDragOver={(event) => event.preventDefault()} onDrop={handleDrop}>
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark">P</div>
          <div>
            <div className="brand-name">Pitchform</div>
            <div className="brand-tagline">Edit vocals like notes.</div>
          </div>
        </div>
        <div className="top-actions">
          <button className="quiet-button" onClick={() => projectInputRef.current?.click()}>Open</button>
          <button className="quiet-button" onClick={handleSaveProject} disabled={!source || isBusy || isRendering}>Save project{isDirty ? ' *' : ''}</button>
          <button className="primary-button" onClick={handleExport} disabled={!source || isBusy || isRendering}>Export WAV</button>
        </div>
      </header>

      <main className="workspace">
        {!source ? (
          <section className="drop-zone" aria-label="Drop audio to begin">
            <div className="drop-orbit"><span>♪</span></div>
            <h1>Drop a vocal here</h1>
            <p>See the notes. Move the pitch. Hear the difference.</p>
            <button className="primary-button large" onClick={() => audioInputRef.current?.click()}>Choose audio file</button>
            <div className="format-hint">WAV · MP3 · FLAC · local processing</div>
          </section>
        ) : (
          <section className="editor-panel">
            <div className="editor-toolbar">
              <div className="toolbar-group">
                <button className="icon-button" onClick={togglePlay} aria-label={isPlaying ? 'Pause' : 'Play'}>{isPlaying ? 'Ⅱ' : '▶'}</button>
                <button className="icon-button" onClick={stopPlayback} aria-label="Stop">■</button>
                <span className="time-readout">{formatTime(playheadSeconds)} / {formatTime(durationSeconds)}</span>
              </div>
              <div className="toolbar-group center-tools">
                <button className={previewMode === 'original' ? 'toggle-button active' : 'toggle-button'} onClick={() => setPreviewMode('original')}>Original</button>
                <button className={previewMode === 'corrected' ? 'toggle-button active' : 'toggle-button'} onClick={() => setPreviewMode('corrected')}>Corrected</button>
                <button className={loopEnabled ? 'toggle-button active' : 'toggle-button'} onClick={toggleLoop}>Loop</button>
              </div>
              <div className="toolbar-group">
                <button className="icon-button" onClick={undo} disabled={history.current.length === 0} aria-label="Undo">↶</button>
                <button className="icon-button" onClick={redo} disabled={future.current.length === 0} aria-label="Redo">↷</button>
                <label className="zoom-control">Zoom <input type="range" min="1" max="4" step="0.5" value={zoom} onChange={(event) => { const nextZoom = Number(event.target.value); setZoom(nextZoom); updateDirtyState(latestNotes.current, nextZoom); }} /></label>
              </div>
            </div>
            <EditorCanvas
              durationSeconds={durationSeconds}
              waveform={source.samples}
              frames={source.frames}
              notes={notes}
              selectedNoteId={selectedNoteId}
              zoom={zoom}
              snapToSemitone={snapToSemitone}
              playheadSeconds={playheadSeconds}
              loopSelection={loopSelection}
              scrollLeft={scrollLeft}
              onScrollLeftChange={setScrollLeft}
              onSelectNote={(noteId) => { setSelectedNoteId(noteId); if (noteId) { const note = notes.find((item) => item.id === noteId); if (note) seekTo(note.startSeconds); } }}
              onSeekSeconds={seekTo}
              onLoopSelectionChange={(selection) => { const nextSelection = selection && selection.endSeconds > selection.startSeconds ? selection : null; setLoopSelection(nextSelection); updateDirtyState(latestNotes.current, zoom, snapToSemitone, nextSelection); }}
              onChangeNotePitch={(noteId, pitch, fine) => { beginNoteEdit(); changeNotePitch(noteId, pitch, fine); }}
              onCommitNotePitch={commitNoteEdit}
            />
            <div className="bottom-panel">
              <div className="file-summary">
                <div className="audio-dot" />
                <div><strong>{source.file.name}</strong><span>{durationSeconds.toFixed(1)} sec · {source.buffer.sampleRate.toLocaleString()} Hz · {notes.length} notes</span></div>
              </div>
              <div className="edit-summary">
                {selectedNote ? <><span className="eyebrow">SELECTED NOTE</span><strong>{selectedNote.targetPitchMidi.toFixed(2)} MIDI</strong><span className={selectedNote.targetPitchMidi === Math.round(selectedNote.originalPitchMidi) ? 'neutral' : 'accent'}>{selectedNote.targetPitchMidi - selectedNote.originalPitchMidi >= 0 ? '+' : ''}{(selectedNote.targetPitchMidi - selectedNote.originalPitchMidi).toFixed(2)} semitones</span><button className="reset-button" onClick={resetSelectedNote} disabled={!isNotePitchEdited(selectedNote) || isBusy || isRendering}>Reset</button></> : <span>Select a note to edit</span>}
              </div>
              <div className="edit-options">
                <label><input type="checkbox" checked={snapToSemitone} onChange={(event) => { const nextSnapToSemitone = event.target.checked; setSnapToSemitone(nextSnapToSemitone); updateDirtyState(latestNotes.current, zoom, nextSnapToSemitone, loopSelection); }} /> Snap</label>
                <span className="hint">Shift-drag / ↑↓ for fine pitch · R reset · Space play</span>
              </div>
            </div>
          </section>
        )}

        <div className="status-line" role="status" aria-live="polite"><span className={isBusy || isRendering ? 'status-dot busy' : 'status-dot'} />{isBusy ? status : isRendering ? 'Rendering corrected preview…' : status}{isDirty ? ' · unsaved changes' : ''}{loopEnabled && durationSeconds > 0 ? ` · loop ${formatTime(loopRange.start)}–${formatTime(loopRange.end)}` : ''}</div>
        {error && <div className="error-banner" role="alert">{error}<button onClick={() => setError(null)}>Dismiss</button></div>}
      </main>

      <footer className="footer"><span>Local first · no uploads · no account</span><span>Pitchform {0.1.toFixed(1)}</span></footer>
      <audio ref={audioRef} onTimeUpdate={onTimeUpdate} onPlay={() => setIsPlaying(true)} onPause={() => setIsPlaying(false)} onEnded={onEnded} onError={() => setError('Could not play the current audio preview.')} />
      <input ref={audioInputRef} type="file" hidden accept="audio/wav,audio/x-wav,audio/mpeg,audio/flac,.wav,.mp3,.flac" onChange={(event) => { const file = event.target.files?.[0]; if (file) void loadAudio(file); event.target.value = ''; }} />
      <input ref={projectInputRef} type="file" hidden accept="application/json,.pitchform" onChange={(event) => { const file = event.target.files?.[0]; if (file) void handleProjectFile(file); event.target.value = ''; }} />
    </div>
  );
}
