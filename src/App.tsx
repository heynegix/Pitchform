import { useCallback, useEffect, useRef, useState } from 'react';
import { EditorCanvas } from './components/EditorCanvas';
import { audioBufferToMono, encodeWav, renderCorrectedSamples } from './lib/audio';
import { analyzeMonophonic, segmentNotes } from './lib/analysis';
import { base64ToBytes, createPitchformProject, isPitchformProject, MAX_PROJECT_FILE_BYTES, projectToJson, sha256Hex } from './lib/project';
import type { AudioSourceMetadata, EditorState, Note, PitchFrame, PitchformProject } from './types';
import './styles.css';

interface LoadedSource {
  file: File;
  buffer: AudioBuffer;
  samples: Float32Array;
  frames: PitchFrame[];
  metadata: AudioSourceMetadata;
}

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
    return { buffer, raw };
  } finally {
    await context.close();
  }
}

function isAbortError(error: unknown): boolean {
  return (error instanceof DOMException && error.name === 'AbortError')
    || (error instanceof Error && error.name === 'AbortError');
}

async function analyzeInWorker(samples: Float32Array, sampleRate: number, signal?: AbortSignal): Promise<{ frames: PitchFrame[]; notes: Note[] }> {
  if (signal?.aborted) throw new DOMException('Analysis cancelled.', 'AbortError');
  if (typeof Worker === 'undefined') {
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    if (signal?.aborted) throw new DOMException('Analysis cancelled.', 'AbortError');
    const frames = analyzeMonophonic(samples, sampleRate);
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
          const frames = analyzeMonophonic(samples, sampleRate);
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
    worker.onmessage = (event: MessageEvent<{ frames?: PitchFrame[]; notes?: Note[]; error?: string }>) => {
      if (settled) return;
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
  const selectedNote = notes.find((note) => note.id === selectedNoteId) ?? null;
  const durationSeconds = source?.buffer.duration ?? 0;
  const loopRange = selectedNote ? { start: selectedNote.startSeconds, end: selectedNote.endSeconds } : { start: 0, end: durationSeconds };
  const activeUrl = previewMode === 'original' ? originalUrl : correctedUrl ?? originalUrl;

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
      audio.currentTime = Math.min(time, Number.isFinite(audio.duration) ? audio.duration : time);
      if (shouldResume) void audio.play().catch(() => setIsPlaying(false));
    };
    audio.addEventListener('loadedmetadata', restore, { once: true });
    return () => audio.removeEventListener('loadedmetadata', restore);
  }, [activeUrl]);

  const loadAudio = useCallback(async (file: File) => {
    operationId.current += 1;
    const thisOperation = operationId.current;
    analysisAbort.current?.abort();
    const controller = new AbortController();
    analysisAbort.current = controller;
    setError(null);
    setIsBusy(true);
    audioRef.current?.pause();
    setIsPlaying(false);
    setLoopEnabled(false);
    setStatus(`Loading ${file.name}…`);
    try {
      const { buffer, raw } = await decodeAudioFile(file);
      if (controller.signal.aborted || thisOperation !== operationId.current) return;
      const samples = audioBufferToMono(buffer);
      const fingerprint = await sha256Hex(raw);
      if (controller.signal.aborted || thisOperation !== operationId.current) return;
      setStatus('Listening for notes…');
      const analysis = await analyzeInWorker(samples, buffer.sampleRate, controller.signal);
      if (controller.signal.aborted || thisOperation !== operationId.current) return;
      setSource({
        file,
        buffer,
        samples,
        frames: analysis.frames,
        metadata: { name: file.name, size: file.size, lastModified: file.lastModified, sha256: fingerprint },
      });
      setNotes(analysis.notes);
      setSelectedNoteId(analysis.notes[0]?.id ?? null);
      history.current = [];
      future.current = [];
      setPlayheadSeconds(0);
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
  }, []);

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
    const projectNotes = cloneNotes(project.edits.notes);
    setSource({ file, buffer, samples, frames: project.analysis.frames, metadata: { ...project.sourceAudio } });
    setNotes(projectNotes);
    setSelectedNoteId(projectNotes[0]?.id ?? null);
    setZoom(project.editorState.zoom);
    setScrollLeft(project.editorState.scrollLeft);
    setSnapToSemitone(project.editorState.snapToSemitone);
    history.current = [];
    future.current = [];
    setPlayheadSeconds(0);
    setLoopEnabled(false);
    setPreviewMode('corrected');
    setStatus(`Opened ${project.sourceAudio.name}`);
  }, []);

  const handleProjectFile = async (file: File) => {
    operationId.current += 1;
    const thisOperation = operationId.current;
    analysisAbort.current?.abort();
    setError(null);
    setIsBusy(true);
    audioRef.current?.pause();
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
    const target = fine ? Math.round(pitch * 4) / 4 : Math.round(pitch);
    setNotes((current) => current.map((note) => note.id === noteId
      ? { ...note, targetPitchMidi: target, centsOffset: (target - note.originalPitchMidi) * 100 }
      : note));
  };

  const beginNoteEdit = () => {
    if (!dragStartNotes.current) dragStartNotes.current = cloneNotes(notes);
  };

  const commitNoteEdit = () => {
    const before = dragStartNotes.current;
    dragStartNotes.current = null;
    if (!before) return;
    setNotes((current) => {
      if (notesEqual(before, current)) return current;
      history.current.push(before);
      future.current = [];
      return current;
    });
    setStatus('Note edit ready to preview');
  };

  const undo = () => {
    const previous = history.current.pop();
    if (!previous) return;
    setNotes((current) => {
      future.current.push(cloneNotes(current));
      return cloneNotes(previous);
    });
    setStatus('Undid last edit');
  };

  const redo = () => {
    const next = future.current.pop();
    if (!next) return;
    setNotes((current) => {
      history.current.push(cloneNotes(current));
      return cloneNotes(next);
    });
    setStatus('Redid last edit');
  };

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio || !activeUrl) return;
    if (audio.paused) void audio.play().then(() => setIsPlaying(true)).catch(() => setError('Playback was blocked by the browser.'));
    else audio.pause();
  };

  const stopPlayback = () => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.pause();
    audio.currentTime = 0;
    setPlayheadSeconds(0);
  };

  const toggleLoop = () => {
    setLoopEnabled((enabled) => {
      const next = !enabled;
      if (next && audioRef.current) audioRef.current.currentTime = loopRange.start;
      return next;
    });
  };

  const handleSaveProject = () => {
    if (!source) return;
    try {
      const editorState: EditorState = { zoom, scrollLeft, snapToSemitone };
      const metadata: AudioSourceMetadata = { ...source.metadata };
      const project = createPitchformProject(metadata, source.buffer.sampleRate, durationSeconds, source.samples, source.frames, notes, editorState);
      downloadBlob(new Blob([projectToJson(project)], { type: 'application/json' }), `${outputBaseName(source.file.name)}.pitchform`);
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
      audio.currentTime = loopRange.start;
      setPlayheadSeconds(loopRange.start);
      void audio.play().catch(() => setIsPlaying(false));
    }
  };

  const onEnded = () => {
    const audio = audioRef.current;
    if (loopEnabled && audio && loopRange.end > loopRange.start) {
      audio.currentTime = loopRange.start;
      setPlayheadSeconds(loopRange.start);
      void audio.play().catch(() => setIsPlaying(false));
      return;
    }
    setIsPlaying(false);
  };

  return (
    <div className="app-shell" onDragOver={(event) => event.preventDefault()} onDrop={handleDrop}>
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
          <button className="quiet-button" onClick={handleSaveProject} disabled={!source || isBusy || isRendering}>Save project</button>
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
                <label className="zoom-control">Zoom <input type="range" min="1" max="4" step="0.5" value={zoom} onChange={(event) => setZoom(Number(event.target.value))} /></label>
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
              onScrollLeftChange={setScrollLeft}
              onSelectNote={(noteId) => { setSelectedNoteId(noteId); if (noteId) { const note = notes.find((item) => item.id === noteId); if (note && audioRef.current) audioRef.current.currentTime = note.startSeconds; } }}
              onChangeNotePitch={(noteId, pitch, fine) => { beginNoteEdit(); changeNotePitch(noteId, pitch, fine); }}
              onCommitNotePitch={commitNoteEdit}
            />
            <div className="bottom-panel">
              <div className="file-summary">
                <div className="audio-dot" />
                <div><strong>{source.file.name}</strong><span>{durationSeconds.toFixed(1)} sec · {source.buffer.sampleRate.toLocaleString()} Hz · {notes.length} notes</span></div>
              </div>
              <div className="edit-summary">
                {selectedNote ? <><span className="eyebrow">SELECTED NOTE</span><strong>{selectedNote.targetPitchMidi.toFixed(2)} MIDI</strong><span className={selectedNote.targetPitchMidi === Math.round(selectedNote.originalPitchMidi) ? 'neutral' : 'accent'}>{selectedNote.targetPitchMidi - selectedNote.originalPitchMidi >= 0 ? '+' : ''}{(selectedNote.targetPitchMidi - selectedNote.originalPitchMidi).toFixed(2)} semitones</span></> : <span>Select a note to edit</span>}
              </div>
              <div className="edit-options">
                <label><input type="checkbox" checked={snapToSemitone} onChange={(event) => setSnapToSemitone(event.target.checked)} /> Snap</label>
                <span className="hint">Shift-drag for fine pitch</span>
              </div>
            </div>
          </section>
        )}

        <div className="status-line" role="status"><span className={isBusy || isRendering ? 'status-dot busy' : 'status-dot'} />{isBusy ? status : isRendering ? 'Rendering corrected preview…' : status}{loopEnabled && durationSeconds > 0 ? ` · loop ${formatTime(loopRange.start)}–${formatTime(loopRange.end)}` : ''}</div>
        {error && <div className="error-banner" role="alert">{error}<button onClick={() => setError(null)}>Dismiss</button></div>}
      </main>

      <footer className="footer"><span>Local first · no uploads · no account</span><span>Pitchform {0.1.toFixed(1)}</span></footer>
      <audio ref={audioRef} onTimeUpdate={onTimeUpdate} onPlay={() => setIsPlaying(true)} onPause={() => setIsPlaying(false)} onEnded={onEnded} />
      <input ref={audioInputRef} type="file" hidden accept="audio/wav,audio/x-wav,audio/mpeg,audio/flac,.wav,.mp3,.flac" onChange={(event) => { const file = event.target.files?.[0]; if (file) void loadAudio(file); event.target.value = ''; }} />
      <input ref={projectInputRef} type="file" hidden accept="application/json,.pitchform" onChange={(event) => { const file = event.target.files?.[0]; if (file) void handleProjectFile(file); event.target.value = ''; }} />
    </div>
  );
}
