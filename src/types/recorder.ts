export type RecordingMode = 'tab_plus_mic' | 'mic_only';

export interface TimestampNote {
  id: string;
  elapsedSec: number;
  label: string;
  createdAt: number;
  wantsScreenshot?: boolean;
  hasLocalSnapshot?: boolean;
}

export interface MeetingRecordMeta {
  id: string;
  title: string;
  mode: RecordingMode;
  includeMicInTabMode: boolean;
  includeLightScreenVideo?: boolean;
  startedAt: number;
  endedAt: number;
  durationSec: number;
  sizeBytes: number;
  mimeType: string;
  fileExt: string;
  fileName: string;
  notes: TimestampNote[];
  summaryMemo?: string;
  updatedAt: number;
}

export interface ActiveCrashSessionMeta {
  sessionId: string;
  title: string;
  mode: RecordingMode;
  includeMicInTabMode: boolean;
  includeLightScreenVideo?: boolean;
  startedAt: number;
  lastChunkAt: number;
  elapsedSec: number;
  chunkCount: number;
  totalBytes: number;
  mimeType: string;
  fileExt: string;
  notes: TimestampNote[];
}

export interface VaultState {
  version: number;
  /** 0 represents unedited initial default state (never overwrites cloud!) */
  updatedAt: number;
  records: MeetingRecordMeta[];
  presets: string[];
  driveFolderUrl: string;
  deletedIds: Record<string, number>;
}

export const DEFAULT_MEETING_PRESETS: string[] = [
  'PMO QA Sync Weekly',
  'QA Sync (w)',
  'Weekly Sync',
  'Bug Bash / Feature Sync',
];

export function createInitialVaultState(): VaultState {
  return {
    version: 1,
    updatedAt: 0,
    records: [],
    presets: [...DEFAULT_MEETING_PRESETS],
    driveFolderUrl: '',
    deletedIds: {},
  };
}

export function formatDuration(totalSec: number): string {
  const safe = Math.max(0, Math.floor(totalSec));
  const hrs = Math.floor(safe / 3600);
  const mins = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  if (hrs > 0) {
    return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDateTimeLabel(ts: number): string {
  const d = new Date(ts);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${yyyy}/${mm}/${dd} ${hh}:${min}`;
}

export function buildSafeAudioFilename(title: string, startedAt: number, fileExt: string): string {
  const d = new Date(startedAt);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  const cleanTitle = (title || 'Meeting')
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 48);
  const ext = fileExt.replace(/^\./, '') || 'webm';
  return `Meet_${yyyy}-${mm}-${dd}_${hh}${min}_${cleanTitle || 'Audio'}.${ext}`;
}

export function detectSupportedAudioFormat(): { mimeType: string; fileExt: string } {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
    return { mimeType: '', fileExt: 'webm' };
  }
  const candidates: Array<{ mimeType: string; fileExt: string }> = [
    { mimeType: 'audio/webm;codecs=opus', fileExt: 'webm' },
    { mimeType: 'audio/webm', fileExt: 'webm' },
    { mimeType: 'audio/mp4;codecs=mp4a.40.2', fileExt: 'm4a' },
    { mimeType: 'audio/mp4', fileExt: 'm4a' },
    { mimeType: 'audio/ogg;codecs=opus', fileExt: 'ogg' },
  ];
  for (const c of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(c.mimeType)) {
        return c;
      }
    } catch {
      // Ignore unsupported check error
    }
  }
  return { mimeType: '', fileExt: 'webm' };
}

export function detectSupportedLightVideoFormat(): { mimeType: string; fileExt: string } {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
    return { mimeType: '', fileExt: 'webm' };
  }
  const candidates: Array<{ mimeType: string; fileExt: string }> = [
    { mimeType: 'video/webm;codecs=vp9,opus', fileExt: 'webm' },
    { mimeType: 'video/webm;codecs=vp8,opus', fileExt: 'webm' },
    { mimeType: 'video/webm', fileExt: 'webm' },
    { mimeType: 'video/mp4', fileExt: 'mp4' },
  ];
  for (const c of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(c.mimeType)) {
        return c;
      }
    } catch {
      // Ignore unsupported check error
    }
  }
  return { mimeType: '', fileExt: 'webm' };
}

export function noteMentionsScreenshot(label: string): boolean {
  return /截圖|畫面|擷圖|拍下來|存圖|投影片|表格|screenshot|snapshot|slide/i.test(label);
}
