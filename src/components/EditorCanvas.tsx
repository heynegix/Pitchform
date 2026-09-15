import { useEffect, useRef, useState } from 'react';
import type { Note, PitchFrame } from '../types';

interface EditorCanvasProps {
  durationSeconds: number;
  waveform: Float32Array;
  frames: PitchFrame[];
  notes: Note[];
  selectedNoteId: string | null;
  zoom: number;
  snapToSemitone: boolean;
  playheadSeconds: number;
  onScrollLeftChange: (scrollLeft: number) => void;
  onSelectNote: (noteId: string | null) => void;
  onChangeNotePitch: (noteId: string, pitch: number, fine: boolean) => void;
  onCommitNotePitch: (noteId: string) => void;
}

const CANVAS_HEIGHT = 520;
const TOP_PADDING = 28;
const WAVEFORM_HEIGHT = 74;
const PIANO_WIDTH = 52;
const MAX_DRAWN_FRAMES = 12_000;

function pitchBounds(notes: Note[]): { topMidi: number; bottomMidi: number } {
  return {
    topMidi: notes.reduce((highest, note) => Math.max(highest, note.targetPitchMidi + 4), 84),
    bottomMidi: notes.reduce((lowest, note) => Math.min(lowest, note.targetPitchMidi - 4), 36),
  };
}

function midiLabel(midi: number): string {
  const names = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
  return `${names[((Math.round(midi) % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
}

function isBlackKey(midi: number): boolean {
  return [1, 3, 6, 8, 10].includes(((midi % 12) + 12) % 12);
}

export function EditorCanvas({
  durationSeconds,
  waveform,
  frames,
  notes,
  selectedNoteId,
  zoom,
  snapToSemitone,
  playheadSeconds,
  onScrollLeftChange,
  onSelectNote,
  onChangeNotePitch,
  onCommitNotePitch,
}: EditorCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ noteId: string; pointerId: number } | null>(null);
  const [viewportWidth, setViewportWidth] = useState(900);
  const timelineWidth = Math.max(760, viewportWidth * Math.max(1, zoom));

  useEffect(() => {
    const element = scrollerRef.current;
    if (!element) return;
    const updateWidth = () => setViewportWidth(Math.max(320, element.clientWidth));
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateWidth);
      updateWidth();
      return () => window.removeEventListener('resize', updateWidth);
    }
    const observer = new ResizeObserver(updateWidth);
    observer.observe(element);
    updateWidth();
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || durationSeconds <= 0) return;
    const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    canvas.width = Math.floor(timelineWidth * dpr);
    canvas.height = CANVAS_HEIGHT * dpr;
    canvas.style.width = `${timelineWidth}px`;
    canvas.style.height = `${CANVAS_HEIGHT}px`;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.scale(dpr, dpr);
    const width = timelineWidth;
    const height = CANVAS_HEIGHT;
    const chartBottom = height - WAVEFORM_HEIGHT;
    const { topMidi, bottomMidi } = pitchBounds(notes);
    const pitchRange = Math.max(12, topMidi - bottomMidi);
    const timeToX = (seconds: number) => (seconds / durationSeconds) * width;
    const pitchToY = (midi: number) => TOP_PADDING + ((topMidi - midi) / pitchRange) * (chartBottom - TOP_PADDING - 12);

    context.fillStyle = '#111827';
    context.fillRect(0, 0, width, height);
    context.fillStyle = '#0b1220';
    context.fillRect(0, chartBottom, width, WAVEFORM_HEIGHT);

    for (let midi = Math.floor(bottomMidi); midi <= Math.ceil(topMidi); midi += 1) {
      const y = pitchToY(midi);
      context.strokeStyle = midi % 12 === 0 ? '#334155' : isBlackKey(midi) ? '#1f2937' : '#182335';
      context.lineWidth = midi % 12 === 0 ? 1.2 : 1;
      context.beginPath();
      context.moveTo(PIANO_WIDTH, y);
      context.lineTo(width, y);
      context.stroke();
      if (midi % 12 === 0) {
        context.fillStyle = '#94a3b8';
        context.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
        context.fillText(midiLabel(midi), 8, y - 4);
      }
    }

    const secondsPerGrid = zoom >= 2 ? 0.5 : 1;
    for (let seconds = 0; seconds <= durationSeconds; seconds += secondsPerGrid) {
      const x = timeToX(seconds);
      context.strokeStyle = '#243244';
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(x, 0);
      context.lineTo(x, chartBottom);
      context.stroke();
      context.fillStyle = '#64748b';
      context.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
      context.fillText(`${seconds.toFixed(secondsPerGrid < 1 ? 1 : 0)}s`, x + 4, 16);
    }

    // Piano keys form a stable visual anchor on the left edge of the editor.
    for (let midi = Math.floor(bottomMidi); midi <= Math.ceil(topMidi); midi += 1) {
      const y = pitchToY(midi);
      const nextY = pitchToY(midi - 1);
      context.fillStyle = isBlackKey(midi) ? '#1f2937' : '#e2e8f0';
      context.fillRect(0, y + 1, PIANO_WIDTH - (isBlackKey(midi) ? 12 : 0), Math.max(1, nextY - y - 2));
      context.strokeStyle = '#64748b';
      context.strokeRect(0, y + 1, PIANO_WIDTH - (isBlackKey(midi) ? 12 : 0), Math.max(1, nextY - y - 2));
    }

    // Original pitch curve.
    context.strokeStyle = '#67e8f9';
    context.lineWidth = 1.5;
    context.globalAlpha = 0.8;
    context.beginPath();
    let curveStarted = false;
    const frameStep = Math.max(1, Math.ceil(frames.length / MAX_DRAWN_FRAMES));
    for (let frameIndex = 0; frameIndex < frames.length; frameIndex += frameStep) {
      const frame = frames[frameIndex];
      if (!frame.voiced || frame.midi === null) {
        curveStarted = false;
        continue;
      }
      const x = timeToX(frame.timeSeconds);
      const y = pitchToY(frame.midi);
      if (!curveStarted) context.moveTo(x, y);
      else context.lineTo(x, y);
      curveStarted = true;
    }
    context.stroke();
    context.globalAlpha = 1;

    for (const note of notes) {
      const x = Math.max(PIANO_WIDTH, timeToX(note.startSeconds));
      const noteWidth = Math.max(7, timeToX(note.endSeconds) - timeToX(note.startSeconds));
      const centerY = pitchToY(note.targetPitchMidi);
      const isSelected = note.id === selectedNoteId;
      const gradient = context.createLinearGradient(0, centerY - 14, 0, centerY + 14);
      gradient.addColorStop(0, isSelected ? '#fbbf24' : '#818cf8');
      gradient.addColorStop(1, isSelected ? '#f97316' : '#4f46e5');
      context.fillStyle = gradient;
      context.globalAlpha = isSelected ? 1 : 0.9;
      context.beginPath();
      context.roundRect(x, centerY - 13, noteWidth, 26, 7);
      context.fill();
      context.globalAlpha = 1;
      context.fillStyle = isSelected ? '#fff7ed' : '#e0e7ff';
      context.font = 'bold 11px ui-sans-serif, system-ui, sans-serif';
      if (noteWidth > 34) context.fillText(midiLabel(note.targetPitchMidi), x + 8, centerY + 4);
      if (note.targetPitchMidi !== Math.round(note.originalPitchMidi) && noteWidth > 48) {
        context.fillStyle = '#fed7aa';
        context.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
        context.fillText(`${note.targetPitchMidi > note.originalPitchMidi ? '+' : ''}${(note.targetPitchMidi - note.originalPitchMidi).toFixed(1)} st`, x + 8, centerY + 17);
      }
    }

    const waveformStep = Math.max(1, Math.ceil(waveform.length / Math.max(1, width)));
    context.strokeStyle = '#38bdf8';
    context.globalAlpha = 0.75;
    context.beginPath();
    for (let pixel = 0; pixel < width; pixel += 1) {
      const start = pixel * waveformStep;
      const end = Math.min(waveform.length, start + waveformStep);
      if (start >= end) break;
      let peak = 0;
      for (let index = start; index < end; index += 1) peak = Math.max(peak, Math.abs(waveform[index]));
      const x = pixel;
      const amplitude = Math.min(1, peak) * (WAVEFORM_HEIGHT / 2 - 10);
      const center = chartBottom + WAVEFORM_HEIGHT / 2;
      context.moveTo(x, center - amplitude);
      context.lineTo(x, center + amplitude);
    }
    context.stroke();
    context.globalAlpha = 1;
    context.fillStyle = '#64748b';
    context.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    context.fillText('WAVEFORM', 10, chartBottom + 16);

    const playheadX = timeToX(Math.max(0, Math.min(durationSeconds, playheadSeconds)));
    context.strokeStyle = '#f8fafc';
    context.lineWidth = 1.5;
    context.beginPath();
    context.moveTo(playheadX, 0);
    context.lineTo(playheadX, height);
    context.stroke();
  }, [durationSeconds, frames, notes, playheadSeconds, selectedNoteId, timelineWidth, waveform, zoom]);

  const pitchAtClientY = (clientY: number): number => {
    const canvas = canvasRef.current;
    if (!canvas) return 60;
    const rect = canvas.getBoundingClientRect();
    const chartBottom = CANVAS_HEIGHT - WAVEFORM_HEIGHT;
    const { topMidi, bottomMidi } = pitchBounds(notes);
    const pitchRange = Math.max(12, topMidi - bottomMidi);
    return topMidi - ((clientY - rect.top - TOP_PADDING) / (chartBottom - TOP_PADDING - 12)) * pitchRange;
  };

  const noteAtClientPoint = (clientX: number, clientY: number): Note | undefined => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const rect = canvas.getBoundingClientRect();
    const seconds = ((clientX - rect.left) / rect.width) * durationSeconds;
    const pitch = pitchAtClientY(clientY);
    for (let index = notes.length - 1; index >= 0; index -= 1) {
      const note = notes[index];
      if (seconds >= note.startSeconds && seconds <= note.endSeconds && Math.abs(note.targetPitchMidi - pitch) < 1.1) return note;
    }
    return undefined;
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0) return;
    const note = noteAtClientPoint(event.clientX, event.clientY);
    if (!note) {
      onSelectNote(null);
      return;
    }
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Some embedded webviews can lose the canvas between pointerdown and capture.
      return;
    }
    dragRef.current = { noteId: note.id, pointerId: event.pointerId };
    onSelectNote(note.id);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!dragRef.current || dragRef.current.pointerId !== event.pointerId) return;
    const pitch = pitchAtClientY(event.clientY);
    onChangeNotePitch(dragRef.current.noteId, pitch, event.shiftKey || !snapToSemitone);
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    onCommitNotePitch(drag.noteId);
  };

  return (
    <div className="editor-scroll" ref={scrollerRef} onScroll={(event) => onScrollLeftChange(event.currentTarget.scrollLeft)}>
      <canvas
        aria-label="Pitchform piano roll editor"
        className="editor-canvas"
        ref={canvasRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      />
    </div>
  );
}
