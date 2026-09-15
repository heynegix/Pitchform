export interface PitchFrame {
  timeSeconds: number;
  frequencyHz: number | null;
  midi: number | null;
  confidence: number;
  voiced: boolean;
}

export interface Note {
  id: string;
  startSeconds: number;
  endSeconds: number;
  originalPitchMidi: number;
  targetPitchMidi: number;
  centsOffset: number;
  confidence: number;
}

export interface AudioSourceMetadata {
  name: string;
  size: number;
  lastModified: number;
  sha256: string;
}

export interface EditorState {
  zoom: number;
  scrollLeft: number;
  snapToSemitone: boolean;
}

export interface PitchformProject {
  format: 'pitchform';
  formatVersion: 1;
  pitchformVersion: string;
  createdAt: string;
  sourceAudio: AudioSourceMetadata;
  analysis: {
    sampleRate: number;
    durationSeconds: number;
    frames: PitchFrame[];
  };
  notes: Note[];
  edits: {
    notes: Note[];
  };
  editorState: EditorState;
  audioWavBase64: string;
}

