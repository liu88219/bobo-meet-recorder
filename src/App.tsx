import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Camera,
  Check,
  Cloud,
  Copy,
  Download,
  Eye,
  EyeOff,
  FolderOpen,
  HardDrive,
  Headphones,
  History,
  Lock,
  Mic,
  MicOff,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Settings,
  Sparkles,
  Square,
  Tag,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { BoboEmptyStageBadge, QuokkaRecorderMiniBadge } from './components/QuokkaBoboBadges';
import { deriveVaultIdentity, normalizePasscode } from './services/cryptoVault';
import {
  LocalHistorySnapshot,
  appendCrashRecoveryChunk,
  checkPendingCrashRecoverySession,
  clearCrashRecoverySession,
  deleteAudioBlob,
  deleteNoteScreenshots,
  getAudioBlob,
  getHistorySnapshots,
  getNoteScreenshot,
  hydrateVaultFromIndexedDb,
  listStoredAudioBlobIds,
  loadLocalVaultSync,
  loadRememberedPasscodeAsync,
  loadRememberedPasscodeSync,
  mergeVaultStates,
  parseVaultJson,
  pullVaultFromCloud,
  pushVaultToCloud,
  recoverCrashedSessionToRecord,
  requestPersistentStorage,
  saveAudioBlob,
  saveNoteScreenshot,
  saveRememberedPasscode,
  saveVaultLocally,
  startCrashRecoverySession,
  subscribeToCloudWakeup,
  updateCrashRecoveryMetaOnly,
} from './services/storageAndSync';
import {
  ActiveCrashSessionMeta,
  MeetingRecordMeta,
  RecordingMode,
  TimestampNote,
  VaultState,
  buildSafeAudioFilename,
  detectSupportedAudioFormat,
  detectSupportedLightVideoFormat,
  formatBytes,
  formatDateTimeLabel,
  formatDuration,
  noteMentionsScreenshot,
} from './types/recorder';

const QUICK_STAMP_TAGS = [
  '📸 截圖此畫面',
  '📌 Action Item',
  '✨ Feature Request',
  '❓ 待確認問題',
  '✅ 重要結論',
];

type SyncStatus = 'local_only' | 'syncing' | 'synced' | 'pending_retry';

export default function App() {
  const canCaptureTabAudio = useMemo(() => {
    return (
      typeof navigator !== 'undefined' &&
      Boolean(navigator.mediaDevices && typeof navigator.mediaDevices.getDisplayMedia === 'function')
    );
  }, []);

  const [vault, setVault] = useState<VaultState>(() => loadLocalVaultSync());
  const [localBlobIds, setLocalBlobIds] = useState<Set<string>>(new Set());
  const [activeAudioUrls, setActiveAudioUrls] = useState<Record<string, string>>({});

  // Cloud Vault Passcode & Sync State
  const [passcode, setPasscode] = useState<string>(() => loadRememberedPasscodeSync());
  const [passcodeInput, setPasscodeInput] = useState<string>(() => loadRememberedPasscodeSync());
  const [showPasscode, setShowPasscode] = useState<boolean>(false);
  const [vaultBadge, setVaultBadge] = useState<string>('');
  const [syncStatus, setSyncStatus] = useState<SyncStatus>(() =>
    loadRememberedPasscodeSync() ? 'syncing' : 'local_only'
  );
  const [showSettingsModal, setShowSettingsModal] = useState<boolean>(false);
  const [snapshots, setSnapshots] = useState<LocalHistorySnapshot[]>([]);
  const [driveUrlDraft, setDriveUrlDraft] = useState<string>('');
  const [newPresetDraft, setNewPresetDraft] = useState<string>('');

  // Crash Recovery State
  const [pendingCrashMeta, setPendingCrashMeta] = useState<ActiveCrashSessionMeta | null>(null);

  // Recorder Studio State
  const [meetingTitle, setMeetingTitle] = useState<string>('');
  const [mode, setMode] = useState<RecordingMode>(() =>
    canCaptureTabAudio ? 'tab_plus_mic' : 'mic_only'
  );
  const [includeMicInTabMode, setIncludeMicInTabMode] = useState<boolean>(true);
  const [includeLightScreenVideo, setIncludeLightScreenVideo] = useState<boolean>(true);
  const [isMicMutedLive, setIsMicMutedLive] = useState<boolean>(false);
  const [noteSnapshots, setNoteSnapshots] = useState<Record<string, string>>({});

  const [recState, setRecState] = useState<'idle' | 'starting' | 'recording' | 'paused'>('idle');
  const [elapsedSec, setElapsedSec] = useState<number>(0);
  const [liveBytes, setLiveBytes] = useState<number>(0);
  const [tabLevel, setTabLevel] = useState<number>(0);
  const [micLevel, setMicLevel] = useState<number>(0);
  const [wakeLockActive, setWakeLockActive] = useState<boolean>(false);

  const [liveNotes, setLiveNotes] = useState<TimestampNote[]>([]);
  const [noteInput, setNoteInput] = useState<string>('');

  // UI Feedback Banner & Toast
  const [errorBanner, setErrorBanner] = useState<string>('');
  const [toastMsg, setToastMsg] = useState<string>('');
  const [copiedId, setCopiedId] = useState<string>('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string>('');
  const [editingRecordId, setEditingRecordId] = useState<string>('');
  const [editingTitleDraft, setEditingTitleDraft] = useState<string>('');

  // Refs for Web Audio & MediaRecorder lifecycle
  const vaultRef = useRef<VaultState>(vault);
  vaultRef.current = vault;
  const passcodeRef = useRef<string>(passcode);
  passcodeRef.current = passcode;

  const displayStreamRef = useRef<MediaStream | null>(null);
  const clonedVideoTrackRef = useRef<MediaStreamTrack | null>(null);
  const previewVideoElRef = useRef<HTMLVideoElement | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const micGainRef = useRef<GainNode | null>(null);
  const tabAnalyserRef = useRef<AnalyserNode | null>(null);
  const micAnalyserRef = useRef<AnalyserNode | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const wakeLockRef = useRef<{ release: () => Promise<void> } | null>(null);

  const rafIdRef = useRef<number | null>(null);
  const timerIdRef = useRef<number | null>(null);
  const activeStartMsRef = useRef<number>(0);
  const accumulatedMsRef = useRef<number>(0);
  const lastResumeMsRef = useRef<number>(0);
  const chunksRef = useRef<Blob[]>([]);
  const chunkCountRef = useRef<number>(0);
  const totalBytesRef = useRef<number>(0);
  const sessionMetaRef = useRef<ActiveCrashSessionMeta | null>(null);
  const liveNotesRef = useRef<TimestampNote[]>([]);
  liveNotesRef.current = liveNotes;
  const isStoppingRef = useRef<boolean>(false);

  const showToast = useCallback((msg: string) => {
    setToastMsg(msg);
  }, []);

  useEffect(() => {
    if (!toastMsg) return;
    const t = window.setTimeout(() => setToastMsg(''), 3400);
    return () => window.clearTimeout(t);
  }, [toastMsg]);

  const refreshBlobIds = useCallback(async () => {
    const ids = await listStoredAudioBlobIds();
    setLocalBlobIds(ids);
  }, []);

  const commitVaultUpdate = useCallback(
    async (updater: (prev: VaultState) => VaultState) => {
      const next = updater(vaultRef.current);
      vaultRef.current = next;
      setVault(next);
      await saveVaultLocally(next);
      const activePass = passcodeRef.current;
      if (activePass && next.updatedAt > 0) {
        setSyncStatus('syncing');
        const ok = await pushVaultToCloud(activePass, next);
        setSyncStatus(ok ? 'synced' : 'pending_retry');
      }
    },
    []
  );

  const syncWithCloud = useCallback(
    async (targetPasscode: string, silent = false) => {
      const clean = normalizePasscode(targetPasscode);
      if (!clean) return;
      setSyncStatus('syncing');
      try {
        const { matchedPasscode, remoteState, badge } = await pullVaultFromCloud(clean);
        setVaultBadge(badge);
        if (matchedPasscode !== clean) {
          setPasscode(matchedPasscode);
          setPasscodeInput(matchedPasscode);
          passcodeRef.current = matchedPasscode;
          await saveRememberedPasscode(matchedPasscode);
        }

        const currentLocal = vaultRef.current;
        if (remoteState) {
          const merged = mergeVaultStates(currentLocal, remoteState);
          vaultRef.current = merged;
          setVault(merged);
          await saveVaultLocally(merged);

          if (currentLocal.updatedAt > remoteState.updatedAt) {
            const ok = await pushVaultToCloud(matchedPasscode, merged);
            setSyncStatus(ok ? 'synced' : 'pending_retry');
          } else {
            setSyncStatus('synced');
          }
          if (!silent) showToast(`☁️ 雲端同步完成 (${badge})`);
        } else if (currentLocal.updatedAt > 0) {
          const ok = await pushVaultToCloud(matchedPasscode, currentLocal);
          setSyncStatus(ok ? 'synced' : 'pending_retry');
          if (!silent) {
            showToast(ok ? `☁️ 已建立並同步雲端保險箱 (${badge})` : '⚠️ 暫存本機，待網路恢復自動重試');
          }
        } else {
          setSyncStatus('synced');
          if (!silent) showToast(`☁️ 已連線雲端保險箱 (${badge})`);
        }
      } catch {
        setSyncStatus('pending_retry');
        if (!silent) showToast('⚠️ 雲端連線暫時忙碌，資料已安全存於本機保險箱');
      }
    },
    [showToast]
  );

  // Initial Hydration: Persistent storage, IndexedDB merge, URL `?drive=` auto-binding, Crash check, Cloud pull
  useEffect(() => {
    let mounted = true;
    (async () => {
      await requestPersistentStorage();
      const hydrated = await hydrateVaultFromIndexedDb(vaultRef.current);
      let workingState = hydrated;

      // Support clean `?drive=<folderId_or_url>` one-click bookmark binding (zero hardcoded IDs in repo)
      try {
        const params = new URLSearchParams(window.location.search);
        const driveParam = (params.get('drive') || '').trim();
        if (driveParam) {
          const resolvedUrl = driveParam.startsWith('https://')
            ? driveParam
            : /^[a-zA-Z0-9_-]{15,}$/.test(driveParam)
              ? `https://drive.google.com/drive/folders/${driveParam}`
              : '';
          if (resolvedUrl && resolvedUrl !== workingState.driveFolderUrl) {
            workingState = {
              ...workingState,
              driveFolderUrl: resolvedUrl,
              updatedAt: Date.now(),
            };
            await saveVaultLocally(workingState);
            if (mounted) showToast('📁 已自動綁定專屬 Google Drive 錄音資料夾！');
          }
          params.delete('drive');
          const cleanQuery = params.toString();
          const cleanUrl = `${window.location.pathname}${cleanQuery ? `?${cleanQuery}` : ''}${window.location.hash}`;
          window.history.replaceState({}, '', cleanUrl);
        }
      } catch {
        // Ignore URL parse issues
      }

      if (!mounted) return;
      vaultRef.current = workingState;
      setVault(workingState);
      setDriveUrlDraft(workingState.driveFolderUrl || '');

      await refreshBlobIds();
      const crash = await checkPendingCrashRecoverySession();
      if (mounted && crash) {
        setPendingCrashMeta(crash);
      }

      const savedPass = await loadRememberedPasscodeAsync();
      if (mounted && savedPass) {
        setPasscode(savedPass);
        setPasscodeInput(savedPass);
        passcodeRef.current = savedPass;
        const id = await deriveVaultIdentity(savedPass);
        if (mounted) setVaultBadge(id.fingerprintBadge);
        await syncWithCloud(savedPass, true);
      }
    })();

    return () => {
      mounted = false;
    };
  }, [refreshBlobIds, showToast, syncWithCloud]);

  // Foreground wakeup (`visibilitychange` + `focus` + `online`) & SSE listener
  useEffect(() => {
    if (!passcode) return;
    const onForeground = () => {
      if (document.visibilityState === 'visible') {
        syncWithCloud(passcode, true);
      }
    };
    const onFocus = () => syncWithCloud(passcode, true);
    const onOnline = () => syncWithCloud(passcode, true);

    document.addEventListener('visibilitychange', onForeground);
    window.addEventListener('focus', onFocus);
    window.addEventListener('online', onOnline);
    const unsubSse = subscribeToCloudWakeup(passcode, () => {
      syncWithCloud(passcode, true);
    });

    return () => {
      document.removeEventListener('visibilitychange', onForeground);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('online', onOnline);
      unsubSse();
    };
  }, [passcode, syncWithCloud]);

  // Cleanup Object URLs on unmount
  useEffect(() => {
    return () => {
      Object.values(activeAudioUrls).forEach((u) => URL.revokeObjectURL(u));
    };
  }, [activeAudioUrls]);

  // Warn before accidentally closing browser tab while actively recording
  useEffect(() => {
    if (recState !== 'recording' && recState !== 'paused') return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [recState]);

  const acquireWakeLock = useCallback(async () => {
    try {
      const nav = navigator as Navigator & {
        wakeLock?: { request: (type: 'screen') => Promise<{ release: () => Promise<void> }> };
      };
      if (nav.wakeLock?.request) {
        const lock = await nav.wakeLock.request('screen');
        wakeLockRef.current = lock;
        setWakeLockActive(true);
      }
    } catch {
      setWakeLockActive(false);
    }
  }, []);

  const releaseWakeLock = useCallback(async () => {
    try {
      if (wakeLockRef.current) {
        await wakeLockRef.current.release();
        wakeLockRef.current = null;
      }
    } catch {
      // ignore
    }
    setWakeLockActive(false);
  }, []);

  const cleanupMediaResources = useCallback(async () => {
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    if (timerIdRef.current !== null) {
      window.clearInterval(timerIdRef.current);
      timerIdRef.current = null;
    }
    if (clonedVideoTrackRef.current) {
      clonedVideoTrackRef.current.stop();
      clonedVideoTrackRef.current = null;
    }
    if (previewVideoElRef.current) {
      previewVideoElRef.current.srcObject = null;
      previewVideoElRef.current = null;
    }
    if (displayStreamRef.current) {
      displayStreamRef.current.getTracks().forEach((t) => t.stop());
      displayStreamRef.current = null;
    }
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach((t) => t.stop());
      micStreamRef.current = null;
    }
    if (audioCtxRef.current) {
      try {
        await audioCtxRef.current.close();
      } catch {
        // ignore
      }
      audioCtxRef.current = null;
    }
    micGainRef.current = null;
    tabAnalyserRef.current = null;
    micAnalyserRef.current = null;
    mediaRecorderRef.current = null;
    setTabLevel(0);
    setMicLevel(0);
    await releaseWakeLock();
  }, [releaseWakeLock]);

  const getCurrentElapsedSec = useCallback((): number => {
    const runningExtra =
      lastResumeMsRef.current > 0 ? Date.now() - lastResumeMsRef.current : 0;
    return Math.max(0, Math.floor((accumulatedMsRef.current + runningExtra) / 1000));
  }, []);

  const startLevelMeters = useCallback(() => {
    const readRmsLevel = (analyser: AnalyserNode | null): number => {
      if (!analyser) return 0;
      const buf = new Uint8Array(analyser.fftSize);
      analyser.getByteTimeDomainData(buf);
      let sumSq = 0;
      for (let i = 0; i < buf.length; i++) {
        const centered = (buf[i] - 128) / 128;
        sumSq += centered * centered;
      }
      const rms = Math.sqrt(sumSq / buf.length);
      return Math.min(100, Math.round(rms * 340));
    };

    const tick = () => {
      setTabLevel(readRmsLevel(tabAnalyserRef.current));
      setMicLevel(readRmsLevel(micAnalyserRef.current));
      rafIdRef.current = requestAnimationFrame(tick);
    };
    rafIdRef.current = requestAnimationFrame(tick);
  }, []);

  const stopRecording = useCallback(
    async (autoEndedByTabClose = false) => {
      if (isStoppingRef.current) return;
      const recorder = mediaRecorderRef.current;
      if (!recorder || recorder.state === 'inactive') {
        await cleanupMediaResources();
        setRecState('idle');
        return;
      }

      isStoppingRef.current = true;
      const finalElapsed = Math.max(1, getCurrentElapsedSec());

      await new Promise<void>((resolve) => {
        recorder.onstop = async () => {
          try {
            const meta = sessionMetaRef.current;
            const mimeType =
              recorder.mimeType || meta?.mimeType || 'audio/webm';
            const fileExt = meta?.fileExt || (mimeType.includes('mp4') ? 'm4a' : 'webm');
            const startedAt = meta?.startedAt || activeStartMsRef.current || Date.now();
            const cleanTitle =
              (meta?.title || meetingTitle).trim() ||
              `會議錄音 ${formatDateTimeLabel(startedAt)}`;
            const fullBlob = new Blob(chunksRef.current, { type: mimeType });

            if (fullBlob.size > 0) {
              const recordId = `rec_${startedAt}_${Math.random().toString(36).slice(2, 7)}`;
              await saveAudioBlob(recordId, fullBlob);
              await clearCrashRecoverySession();

              const newRecord: MeetingRecordMeta = {
                id: recordId,
                title: cleanTitle,
                mode: meta?.mode || mode,
                includeMicInTabMode: meta?.includeMicInTabMode ?? includeMicInTabMode,
                includeLightScreenVideo: meta?.includeLightScreenVideo ?? includeLightScreenVideo,
                startedAt,
                endedAt: Date.now(),
                durationSec: finalElapsed,
                sizeBytes: fullBlob.size,
                mimeType,
                fileExt,
                fileName: buildSafeAudioFilename(cleanTitle, startedAt, fileExt),
                notes: [...liveNotesRef.current],
                updatedAt: Date.now(),
              };

              const blobUrl = URL.createObjectURL(fullBlob);
              setActiveAudioUrls((prev) => ({ ...prev, [recordId]: blobUrl }));
              await refreshBlobIds();

              await commitVaultUpdate((prev) => ({
                ...prev,
                updatedAt: Date.now(),
                records: [newRecord, ...prev.records],
              }));

              showToast(
                autoEndedByTabClose
                  ? `✅ 偵測到會議分頁結束分享，已自動封存錄音檔（${formatBytes(fullBlob.size)}）！`
                  : `🎉 錄音已儲存！（共 ${formatDuration(finalElapsed)}・${formatBytes(fullBlob.size)}）`
              );
            } else {
              await clearCrashRecoverySession();
              setErrorBanner('⚠️ 本次錄音時間過短，尚未產生音訊資料。');
            }
          } finally {
            chunksRef.current = [];
            chunkCountRef.current = 0;
            totalBytesRef.current = 0;
            sessionMetaRef.current = null;
            accumulatedMsRef.current = 0;
            lastResumeMsRef.current = 0;
            setElapsedSec(0);
            setLiveBytes(0);
            setLiveNotes([]);
            setIsMicMutedLive(false);
            await cleanupMediaResources();
            setRecState('idle');
            isStoppingRef.current = false;
            resolve();
          }
        };

        try {
          recorder.stop();
        } catch {
          resolve();
        }
      });
    },
    [
      cleanupMediaResources,
      commitVaultUpdate,
      getCurrentElapsedSec,
      includeLightScreenVideo,
      includeMicInTabMode,
      meetingTitle,
      mode,
      refreshBlobIds,
      showToast,
    ]
  );

  const startRecording = async () => {
    setErrorBanner('');
    setRecState('starting');
    isStoppingRef.current = false;

    try {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const audioCtx = new AudioCtx();
      audioCtxRef.current = audioCtx;
      if (audioCtx.state === 'suspended') {
        await audioCtx.resume();
      }
      const dest = audioCtx.createMediaStreamDestination();

      if (mode === 'tab_plus_mic') {
        if (!canCaptureTabAudio) {
          await cleanupMediaResources();
          setRecState('idle');
          setMode('mic_only');
          setErrorBanner(
            '📱 目前瀏覽器不支援抓取電腦分頁音訊（例如手機瀏覽器），已為妳切換為「會議室／隨身純麥克風模式」！'
          );
          return;
        }

        let displayStream: MediaStream;
        try {
          displayStream = await navigator.mediaDevices.getDisplayMedia({
            video: true,
            audio: {
              echoCancellation: false,
              noiseSuppression: false,
              autoGainControl: false,
            } as MediaTrackConstraints,
          });
        } catch {
          await cleanupMediaResources();
          setRecState('idle');
          return;
        }

        displayStreamRef.current = displayStream;
        const rawVidTrack = displayStream.getVideoTracks()[0];
        if (rawVidTrack) {
          const vidEl = document.createElement('video');
          vidEl.muted = true;
          vidEl.playsInline = true;
          vidEl.autoplay = true;
          vidEl.srcObject = new MediaStream([rawVidTrack]);
          vidEl.play().catch(() => {});
          previewVideoElRef.current = vidEl;
        }

        const tabAudioTracks = displayStream.getAudioTracks();
        if (tabAudioTracks.length === 0) {
          await cleanupMediaResources();
          setRecState('idle');
          setErrorBanner(
            '⚠️ 沒有偵測到會議分頁音訊！請再點一次「開始錄音」，在彈出視窗上方選取「Chrome 分頁 (Chrome Tab)」中的 Google Meet 分頁，並確認左下角「同時分享分頁音訊 (Also share tab audio)」有打勾喔！'
          );
          return;
        }

        // Auto-finalize cleanly if Meet tab is closed or Chrome "Stop sharing" is clicked
        tabAudioTracks[0].onended = () => {
          stopRecording(true);
        };

        const tabSource = audioCtx.createMediaStreamSource(new MediaStream([tabAudioTracks[0]]));
        const tabAnalyser = audioCtx.createAnalyser();
        tabAnalyser.fftSize = 256;
        tabAnalyserRef.current = tabAnalyser;
        tabSource.connect(tabAnalyser);
        tabSource.connect(dest);

        if (includeMicInTabMode) {
          try {
            const micStream = await navigator.mediaDevices.getUserMedia({
              audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
              },
            });
            micStreamRef.current = micStream;
            const micSource = audioCtx.createMediaStreamSource(micStream);
            const micGain = audioCtx.createGain();
            micGain.gain.value = 1;
            micGainRef.current = micGain;
            const micAnalyser = audioCtx.createAnalyser();
            micAnalyser.fftSize = 256;
            micAnalyserRef.current = micAnalyser;
            micSource.connect(micGain);
            micGain.connect(micAnalyser);
            micGain.connect(dest);
          } catch {
            showToast('ℹ️ 未開啟麥克風權限，本次將單獨錄製會議分頁音訊');
          }
        }
      } else {
        // Pure Microphone Mode (Conference room / mobile / desk)
        let micStream: MediaStream;
        try {
          micStream = await navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: false,
              noiseSuppression: true,
              autoGainControl: true,
            },
          });
        } catch {
          await cleanupMediaResources();
          setRecState('idle');
          setErrorBanner('⚠️ 無法取得麥克風權限，請確認瀏覽器網址列左側已允許麥克風存取喔！');
          return;
        }
        micStreamRef.current = micStream;
        const micSource = audioCtx.createMediaStreamSource(micStream);
        const micGain = audioCtx.createGain();
        micGain.gain.value = 1;
        micGainRef.current = micGain;
        const micAnalyser = audioCtx.createAnalyser();
        micAnalyser.fftSize = 256;
        micAnalyserRef.current = micAnalyser;
        micSource.connect(micGain);
        micGain.connect(micAnalyser);
        micGain.connect(dest);
      }

      let recorderStream: MediaStream = dest.stream;
      let chosenMime = '';
      let chosenExt = 'webm';
      let recOptions: MediaRecorderOptions = { audioBitsPerSecond: 32000 };

      if (
        mode === 'tab_plus_mic' &&
        includeLightScreenVideo &&
        displayStreamRef.current &&
        displayStreamRef.current.getVideoTracks().length > 0
      ) {
        const clonedVid = displayStreamRef.current.getVideoTracks()[0].clone();
        clonedVideoTrackRef.current = clonedVid;
        try {
          await clonedVid.applyConstraints({
            width: { ideal: 1280, max: 1440 },
            height: { ideal: 720, max: 900 },
            frameRate: { ideal: 1, max: 2 },
          });
        } catch {
          // Ignore if browser ignores frameRate constraint on cloned tab track
        }
        const vidFmt = detectSupportedLightVideoFormat();
        if (vidFmt.mimeType) {
          chosenMime = vidFmt.mimeType;
          chosenExt = vidFmt.fileExt;
          recorderStream = new MediaStream([clonedVid, ...dest.stream.getAudioTracks()]);
          recOptions = {
            mimeType: chosenMime,
            videoBitsPerSecond: 120000,
            audioBitsPerSecond: 32000,
          };
        }
      }

      if (!chosenMime) {
        const audFmt = detectSupportedAudioFormat();
        chosenMime = audFmt.mimeType;
        chosenExt = audFmt.fileExt;
        recOptions = chosenMime
          ? { mimeType: chosenMime, audioBitsPerSecond: 32000 }
          : { audioBitsPerSecond: 32000 };
      }

      const recorder = new MediaRecorder(recorderStream, recOptions);
      mediaRecorderRef.current = recorder;

      const now = Date.now();
      const initialTitle =
        meetingTitle.trim() || `會議錄音 ${formatDateTimeLabel(now)}`;
      const sessionId = `sess_${now}`;
      const initialCrashMeta: ActiveCrashSessionMeta = {
        sessionId,
        title: initialTitle,
        mode,
        includeMicInTabMode,
        includeLightScreenVideo: mode === 'tab_plus_mic' ? includeLightScreenVideo : false,
        startedAt: now,
        lastChunkAt: now,
        elapsedSec: 0,
        chunkCount: 0,
        totalBytes: 0,
        mimeType: recorder.mimeType || chosenMime || 'audio/webm',
        fileExt: chosenExt,
        notes: [],
      };

      chunksRef.current = [];
      chunkCountRef.current = 0;
      totalBytesRef.current = 0;
      sessionMetaRef.current = initialCrashMeta;
      activeStartMsRef.current = now;
      accumulatedMsRef.current = 0;
      lastResumeMsRef.current = now;
      setElapsedSec(0);
      setLiveBytes(0);
      setLiveNotes([]);
      setIsMicMutedLive(false);

      await startCrashRecoverySession(initialCrashMeta);
      await acquireWakeLock();

      recorder.ondataavailable = (e: BlobEvent) => {
        if (!e.data || e.data.size === 0) return;
        const idx = chunkCountRef.current;
        chunkCountRef.current += 1;
        chunksRef.current.push(e.data);
        totalBytesRef.current += e.data.size;
        setLiveBytes(totalBytesRef.current);

        if (sessionMetaRef.current) {
          const updated: ActiveCrashSessionMeta = {
            ...sessionMetaRef.current,
            title: meetingTitle.trim() || sessionMetaRef.current.title,
            lastChunkAt: Date.now(),
            elapsedSec: getCurrentElapsedSec(),
            chunkCount: chunkCountRef.current,
            totalBytes: totalBytesRef.current,
            notes: [...liveNotesRef.current],
          };
          sessionMetaRef.current = updated;
          appendCrashRecoveryChunk(sessionId, idx, e.data, updated).catch(() => {});
        }
      };

      // Slice every 5 seconds for real-time IndexedDB crash protection
      recorder.start(5000);
      setRecState('recording');
      startLevelMeters();

      timerIdRef.current = window.setInterval(() => {
        setElapsedSec(getCurrentElapsedSec());
      }, 500);
    } catch (err) {
      await cleanupMediaResources();
      setRecState('idle');
      setErrorBanner(
        `⚠️ 啟動錄音時發生錯誤：${err instanceof Error ? err.message : '請重新整理頁面再試一次'}`
      );
    }
  };

  const togglePauseResume = () => {
    const recorder = mediaRecorderRef.current;
    if (!recorder) return;
    if (recorder.state === 'recording') {
      recorder.pause();
      accumulatedMsRef.current += Date.now() - lastResumeMsRef.current;
      lastResumeMsRef.current = 0;
      setRecState('paused');
    } else if (recorder.state === 'paused') {
      recorder.resume();
      lastResumeMsRef.current = Date.now();
      setRecState('recording');
    }
  };

  const toggleLiveMicMute = () => {
    if (!micGainRef.current) return;
    const nextMuted = !isMicMutedLive;
    micGainRef.current.gain.value = nextMuted ? 0 : 1;
    setIsMicMutedLive(nextMuted);
  };

  const captureLiveScreenFrame = useCallback((): string | null => {
    const vid = previewVideoElRef.current;
    if (!vid || vid.videoWidth <= 0 || vid.videoHeight <= 0) return null;
    try {
      const maxW = 1440;
      const scale = Math.min(1, maxW / vid.videoWidth);
      const w = Math.max(1, Math.round(vid.videoWidth * scale));
      const h = Math.max(1, Math.round(vid.videoHeight * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(vid, 0, 0, w, h);
      return canvas.toDataURL('image/jpeg', 0.88);
    } catch {
      return null;
    }
  }, []);

  const addLiveTimestampNote = async (textOverride?: string, forceScreenshot = false) => {
    const rawContent = (textOverride ?? noteInput).trim();
    const content = rawContent || (forceScreenshot ? '📸 截圖此畫面重點' : '');
    if (!content) return;
    const sec = getCurrentElapsedSec();
    const wantsShot = forceScreenshot || noteMentionsScreenshot(content);
    const noteId = `note_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

    let capturedDataUrl: string | null = null;
    if (wantsShot && mode === 'tab_plus_mic') {
      capturedDataUrl = captureLiveScreenFrame();
      if (capturedDataUrl) {
        await saveNoteScreenshot(noteId, capturedDataUrl);
        setNoteSnapshots((prev) => ({ ...prev, [noteId]: capturedDataUrl! }));
      }
    }

    const note: TimestampNote = {
      id: noteId,
      elapsedSec: sec,
      label: content,
      createdAt: Date.now(),
      wantsScreenshot: wantsShot,
      hasLocalSnapshot: Boolean(capturedDataUrl),
    };
    const next = [...liveNotesRef.current, note];
    setLiveNotes(next);
    liveNotesRef.current = next;
    if (!textOverride) setNoteInput('');
    if (capturedDataUrl) {
      showToast(`📸 已抓下 [${formatDuration(sec)}] 當下會議畫面並存檔！`);
    }
    if (sessionMetaRef.current) {
      const updated = { ...sessionMetaRef.current, notes: next };
      sessionMetaRef.current = updated;
      updateCrashRecoveryMetaOnly(updated).catch(() => {});
    }
  };

  const handleViewOrDownloadNoteSnapshot = async (note: TimestampNote, recTitle?: string) => {
    let dataUrl = noteSnapshots[note.id] || null;
    if (!dataUrl) {
      dataUrl = await getNoteScreenshot(note.id);
      if (dataUrl) {
        setNoteSnapshots((prev) => ({ ...prev, [note.id]: dataUrl! }));
      }
    }
    if (!dataUrl) {
      showToast('ℹ️ 此截圖可由 AI 直接從 .webm 會議檔案該時間節點自動擷取喔！');
      return;
    }
    const a = document.createElement('a');
    a.href = dataUrl;
    const clean = (recTitle || meetingTitle || 'Meet').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 32);
    a.download = `Screenshot_${clean}_${formatDuration(note.elapsedSec).replace(/:/g, 'm')}s.jpg`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    showToast('🖼️ 已下載該節點的會議畫面截圖！');
  };

  const handleRecoverCrash = async () => {
    if (!pendingCrashMeta) return;
    const recovered = await recoverCrashedSessionToRecord(pendingCrashMeta);
    setPendingCrashMeta(null);
    if (recovered) {
      await refreshBlobIds();
      await commitVaultUpdate((prev) => ({
        ...prev,
        updatedAt: Date.now(),
        records: [recovered, ...prev.records],
      }));
      showToast(`🛟 已成功救援音檔：「${recovered.title}」(${formatBytes(recovered.sizeBytes)})`);
    }
  };

  const handleDiscardCrash = async () => {
    await clearCrashRecoverySession();
    setPendingCrashMeta(null);
    showToast('已清除未完成的暫存片段');
  };

  const handleLoadAudioPreview = async (recordId: string) => {
    if (activeAudioUrls[recordId]) return;
    const blob = await getAudioBlob(recordId);
    if (!blob) {
      showToast('ℹ️ 此音檔儲存於原本錄音的那台裝置上喔！');
      return;
    }
    const url = URL.createObjectURL(blob);
    setActiveAudioUrls((prev) => ({ ...prev, [recordId]: url }));
  };

  const handleDownloadRecord = async (rec: MeetingRecordMeta) => {
    const blob = await getAudioBlob(rec.id);
    if (!blob) {
      showToast('⚠️ 找不到此裝置上的音檔實體（可能是在另一台電腦錄製）');
      return;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = rec.fileName || buildSafeAudioFilename(rec.title, rec.startedAt, rec.fileExt);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.setTimeout(() => URL.revokeObjectURL(url), 5000);
    showToast(`⬇️ 已開始下載「${a.download}」`);
  };

  const handleOpenDriveFolder = () => {
    const target = vault.driveFolderUrl.trim() || 'https://drive.google.com/drive/my-drive';
    window.open(target, '_blank', 'noopener,noreferrer');
  };

  const handleCopyAiPrompt = async (rec: MeetingRecordMeta) => {
    const hasScreenshotReq = rec.notes.some(
      (n) => n.wantsScreenshot || noteMentionsScreenshot(n.label)
    );
    const notesPart =
      rec.notes.length > 0
        ? `\n會議中標記重點：\n${rec.notes
            .map((n) => {
              const needShot = n.wantsScreenshot || noteMentionsScreenshot(n.label);
              return `- [${formatDuration(n.elapsedSec)}] ${n.label}${
                needShot ? ' （📸 請幫我擷取此節點畫面提及的內容並儲存！）' : ''
              }`;
            })
            .join('\n')}`
        : '';
    const shotExtra = hasScreenshotReq
      ? '（注意：請一併幫我把上述標記需截圖的時間節點畫面擷取清晰圖片，儲存至對話 Artifact 並備份到 Meet_Recordings 資料夾！）'
      : '';
    const promptText = `請幫我把這份會議錄音檔「${rec.fileName}」（會議名稱：${rec.title}，時長：${formatDuration(rec.durationSec)}；已直接附檔或上傳至 Meet_Recordings 資料夾）轉成完整逐字稿並整理會議重點與 Action Items！${shotExtra}${notesPart}`;
    try {
      await navigator.clipboard.writeText(promptText);
      setCopiedId(rec.id);
      window.setTimeout(() => setCopiedId(''), 2200);
      showToast('📋 已複製轉逐字稿指令！把音檔丟進雲端資料夾後直接貼上對話即可～');
    } catch {
      showToast('⚠️ 瀏覽器限制自動複製，請手動選取');
    }
  };

  const handleDeleteRecord = async (recId: string) => {
    if (confirmDeleteId !== recId) {
      setConfirmDeleteId(recId);
      window.setTimeout(() => setConfirmDeleteId((cur) => (cur === recId ? '' : cur)), 3500);
      return;
    }
    setConfirmDeleteId('');
    if (activeAudioUrls[recId]) {
      URL.revokeObjectURL(activeAudioUrls[recId]);
      setActiveAudioUrls((prev) => {
        const copy = { ...prev };
        delete copy[recId];
        return copy;
      });
    }
    const targetRec = vaultRef.current.records.find((r) => r.id === recId);
    if (targetRec && targetRec.notes.length > 0) {
      await deleteNoteScreenshots(targetRec.notes.map((n) => n.id));
    }
    await deleteAudioBlob(recId);
    await refreshBlobIds();
    const now = Date.now();
    await commitVaultUpdate((prev) => ({
      ...prev,
      updatedAt: now,
      records: prev.records.filter((r) => r.id !== recId),
      deletedIds: { ...prev.deletedIds, [recId]: now },
    }));
    showToast('🗑️ 已移除該筆錄音紀錄');
  };

  const handleSaveEditedTitle = async (recId: string) => {
    const trimmed = editingTitleDraft.trim();
    setEditingRecordId('');
    if (!trimmed) return;
    const now = Date.now();
    await commitVaultUpdate((prev) => ({
      ...prev,
      updatedAt: now,
      records: prev.records.map((r) =>
        r.id === recId
          ? {
              ...r,
              title: trimmed,
              fileName: buildSafeAudioFilename(trimmed, r.startedAt, r.fileExt),
              updatedAt: now,
            }
          : r
      ),
    }));
    showToast('✏️ 已更新會議名稱與下載檔名');
  };

  const handleBindPasscode = async (e: React.FormEvent) => {
    e.preventDefault();
    const clean = normalizePasscode(passcodeInput);
    if (!clean) {
      setPasscode('');
      passcodeRef.current = '';
      setVaultBadge('');
      setSyncStatus('local_only');
      await saveRememberedPasscode('');
      showToast('已切換為僅本機儲存模式');
      return;
    }
    setPasscode(clean);
    passcodeRef.current = clean;
    await saveRememberedPasscode(clean);
    await syncWithCloud(clean, false);
  };

  const handleSaveDriveUrl = async () => {
    const clean = driveUrlDraft.trim();
    await commitVaultUpdate((prev) => ({
      ...prev,
      updatedAt: Date.now(),
      driveFolderUrl: clean,
    }));
    showToast('📁 已儲存專屬 Google Drive 資料夾連結！');
  };

  const handleAddPreset = async () => {
    const clean = newPresetDraft.trim();
    if (!clean) return;
    setNewPresetDraft('');
    await commitVaultUpdate((prev) => ({
      ...prev,
      updatedAt: Date.now(),
      presets: Array.from(new Set([clean, ...prev.presets])).slice(0, 12),
    }));
  };

  const handleRemovePreset = async (preset: string) => {
    await commitVaultUpdate((prev) => ({
      ...prev,
      updatedAt: Date.now(),
      presets: prev.presets.filter((p) => p !== preset),
    }));
  };

  const handleOpenSettings = async () => {
    setDriveUrlDraft(vault.driveFolderUrl || '');
    const list = await getHistorySnapshots();
    setSnapshots(list);
    setShowSettingsModal(true);
  };

  const handleRestoreSnapshot = async (snap: LocalHistorySnapshot) => {
    const parsed = parseVaultJson(snap.stateJson);
    if (!parsed) return;
    await commitVaultUpdate((prev) => ({
      ...mergeVaultStates(prev, parsed),
      updatedAt: Date.now(),
    }));
    showToast(`🛟 已無損合併還原本機快照（共 ${parsed.records.length} 筆紀錄）`);
  };

  const handleExportJsonBackup = () => {
    const blob = new Blob([JSON.stringify(vault, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `BoboMeet_Backup_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 3000);
  };

  const handleImportJsonBackup = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      const parsed = parseVaultJson(String(reader.result || ''));
      if (!parsed) {
        showToast('⚠️ 備份檔格式不正確');
        return;
      }
      await commitVaultUpdate((prev) => ({
        ...mergeVaultStates(prev, parsed),
        updatedAt: Date.now(),
      }));
      showToast(`✅ 已成功匯入合併 ${parsed.records.length} 筆會議紀錄！`);
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const isBusyRecording = recState === 'recording' || recState === 'paused';

  return (
    <div className="min-h-screen bg-[#ECE8DF] text-[#2D251E] pb-16">
      {/* Floating Toast */}
      {toastMsg && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 max-w-md w-[92%] bg-[#2D251E] text-[#FAF8F3] px-4 py-3 rounded-2xl shadow-lg text-sm font-bold flex items-center gap-2.5 border border-[#5C5044]">
          <Sparkles className="w-4 h-4 text-[#F2CA62] shrink-0" />
          <span>{toastMsg}</span>
        </div>
      )}

      {/* Top Navigation Bar */}
      <header className="sticky top-0 z-30 bg-[#ECE8DF]/90 backdrop-blur-md border-b border-[#DDD7C9]">
        <div className="max-w-3xl mx-auto px-4 py-3 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2.5 min-w-0">
            <QuokkaRecorderMiniBadge isRecording={recState === 'recording'} className="w-11 h-11 shrink-0" />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h1 className="text-lg sm:text-xl font-black tracking-tight text-[#2D251E] truncate">
                  BoboMeet 會議錄音室
                </h1>
              </div>
              <p className="text-xs text-[#5C5044] truncate">
                非主持人也能一鍵收音・1 小時僅 ~14MB
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
            {passcode && vaultBadge && (
              <button
                type="button"
                onClick={handleOpenSettings}
                className="hidden sm:inline-flex items-center gap-1 px-2.5 py-1.5 rounded-xl bg-[#FAF8F3] border border-[#DDD7C9] text-xs font-bold text-[#5C5044]"
                title="雲端保險箱印記"
              >
                <span>{vaultBadge}</span>
              </button>
            )}

            <button
              type="button"
              onClick={() =>
                passcode ? syncWithCloud(passcode, false) : handleOpenSettings()
              }
              className="soft-pill-btn px-3 py-2 text-xs font-bold flex items-center gap-1.5"
              title="跨裝置雲端同步"
            >
              <RefreshCw
                className={`w-3.5 h-3.5 ${syncStatus === 'syncing' ? 'animate-spin text-[#C48E63]' : 'text-[#5C5044]'}`}
              />
              <span>
                {!passcode
                  ? '綁定同步'
                  : syncStatus === 'syncing'
                    ? '同步中'
                    : syncStatus === 'synced'
                      ? '🔄 雲端同步'
                      : '待同步(已存本機)'}
              </span>
            </button>

            <button
              type="button"
              onClick={handleOpenSettings}
              className="soft-pill-btn p-2 text-[#5C5044]"
              aria-label="設定與雲端保險箱"
              title="設定與雲端保險箱"
            >
              <Settings className="w-4 h-4" />
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 pt-5 space-y-5">
        {/* Crash Recovery Banner */}
        {pendingCrashMeta && !isBusyRecording && (
          <div className="bg-[#F2CA62]/35 border-2 border-[#E3B84F] rounded-3xl p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-3.5 shadow-sm">
            <div className="space-y-1">
              <div className="flex items-center gap-2 font-black text-sm sm:text-base text-[#2D251E]">
                <span>🛟 發現一筆未正常結束的會議錄音！</span>
              </div>
              <p className="text-xs sm:text-sm text-[#5C5044]">
                「<strong className="text-[#2D251E]">{pendingCrashMeta.title}</strong>」已自動保護{' '}
                {formatDuration(pendingCrashMeta.elapsedSec)}（{formatBytes(pendingCrashMeta.totalBytes)}）於本機保險箱中。
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={handleRecoverCrash}
                className="butter-btn px-4 py-2 text-xs sm:text-sm font-black"
              >
                ✨ 一鍵還原音檔
              </button>
              <button
                type="button"
                onClick={handleDiscardCrash}
                className="soft-pill-btn px-3 py-2 text-xs font-bold text-[#8A7E70]"
              >
                捨棄
              </button>
            </div>
          </div>
        )}

        {/* Hero Illustration Card */}
        <section className="cream-card overflow-hidden p-4 sm:p-5">
          <div className="grid grid-cols-1 sm:grid-cols-12 gap-4 items-center">
            <div className="sm:col-span-5 rounded-2xl overflow-hidden bg-[#DDD9CE] border border-[#DDD7C9]">
              <img
                src="./assets/hero-mascot.png"
                alt="Quokka 與 BOBO 會議錄音小幫手"
                className="w-full h-44 sm:h-40 object-contain mx-auto select-none"
              />
            </div>
            <div className="sm:col-span-7 space-y-2.5">
              <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-[#F2CA62]/45 text-[#2D251E] text-xs font-extrabold">
                <span>🎙️ 免主持人權限・純音訊超輕量</span>
              </div>
              <h2 className="text-base sm:text-lg font-black text-[#2D251E] leading-snug">
                戴耳機開 Google Meet 或在會議室，都能安心一鍵收音！
              </h2>
              <p className="text-xs sm:text-sm text-[#5C5044] leading-relaxed">
                只錄高品質語音、不錄肥大螢幕畫面——<strong>開會 1 小時檔案僅約 14 MB</strong>（比螢幕錄影小 30 倍），且每 5 秒自動寫入本機防當機保險箱，不怕誤關分頁！
              </p>
            </div>
          </div>
        </section>

        {/* Error Alert Banner */}
        {errorBanner && (
          <div className="bg-[#C83D33]/10 border-1.5 border-[#C83D33]/40 rounded-2xl p-4 flex items-start justify-between gap-3">
            <div className="flex items-start gap-2.5 text-xs sm:text-sm font-bold text-[#912720] leading-relaxed">
              <AlertTriangle className="w-5 h-5 text-[#C83D33] shrink-0 mt-0.5" />
              <span>{errorBanner}</span>
            </div>
            <button
              type="button"
              onClick={() => setErrorBanner('')}
              className="text-[#8A7E70] hover:text-[#2D251E] p-1"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* Main Recording Studio Card */}
        <section className="cream-card p-5 sm:p-6 space-y-5">
          {/* Meeting Title & Quick Presets */}
          <div className="space-y-2.5">
            <label className="block text-xs font-extrabold text-[#5C5044] uppercase tracking-wider">
              1. 會議名稱（點選常用標籤或自由輸入）
            </label>
            <div className="flex flex-wrap gap-1.5">
              {vault.presets.map((preset) => {
                const active = meetingTitle.trim() === preset;
                return (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => setMeetingTitle(preset)}
                    className={`px-3 py-1.5 rounded-full text-xs font-bold border transition ${
                      active
                        ? 'bg-[#F2CA62] border-[#E3B84F] text-[#2D251E]'
                        : 'bg-[#EFECE4] border-[#DDD7C9] text-[#5C5044] hover:bg-[#E5E0D4]'
                    }`}
                  >
                    {preset}
                  </button>
                );
              })}
            </div>
            <input
              type="text"
              value={meetingTitle}
              onChange={(e) => setMeetingTitle(e.target.value)}
              placeholder="例如：PMO QA Sync Weekly（留空會自動帶入日期時間）"
              className="w-full px-4 py-2.5 rounded-2xl bg-[#EFECE4]/70 border border-[#DDD7C9] text-sm font-bold text-[#2D251E] placeholder:text-[#8A7E70] focus:outline-none focus:border-[#C48E63] focus:bg-[#FAF8F3]"
            />
          </div>

          {/* Mode Selection (Disabled while actively recording) */}
          {!isBusyRecording && (
            <div className="space-y-3">
              <label className="block text-xs font-extrabold text-[#5C5044] uppercase tracking-wider">
                2. 選擇收音情境
              </label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => setMode('tab_plus_mic')}
                  className={`text-left p-4 rounded-2xl border-2 transition space-y-1.5 ${
                    mode === 'tab_plus_mic'
                      ? 'bg-[#F2CA62]/20 border-[#C48E63]'
                      : 'bg-[#EFECE4]/60 border-[#DDD7C9] hover:bg-[#EFECE4]'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="inline-flex items-center gap-1.5 font-black text-sm text-[#2D251E]">
                      <Headphones className="w-4 h-4 text-[#C48E63]" />
                      💻 線上會議（分頁＋麥克風）
                    </span>
                    {mode === 'tab_plus_mic' && (
                      <span className="px-2 py-0.5 rounded-full bg-[#F2CA62] text-[11px] font-black">
                        推薦
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-[#5C5044] leading-relaxed">
                    戴耳機開 Google Meet 必選！同時錄下<strong>對方分頁說話聲</strong>與<strong>妳的麥克風</strong>。
                  </p>
                </button>

                <button
                  type="button"
                  onClick={() => setMode('mic_only')}
                  className={`text-left p-4 rounded-2xl border-2 transition space-y-1.5 ${
                    mode === 'mic_only'
                      ? 'bg-[#F2CA62]/20 border-[#C48E63]'
                      : 'bg-[#EFECE4]/60 border-[#DDD7C9] hover:bg-[#EFECE4]'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="inline-flex items-center gap-1.5 font-black text-sm text-[#2D251E]">
                      <Mic className="w-4 h-4 text-[#C48E63]" />
                      🏢 實體會議室／純麥克風
                    </span>
                  </div>
                  <p className="text-xs text-[#5C5044] leading-relaxed">
                    人在實體會議室、電腦開擴音、或用手機放桌上隨身收音時使用（自動開啟防休眠）。
                  </p>
                </button>
              </div>

              {mode === 'tab_plus_mic' && (
                <div className="cream-subcard p-3.5 space-y-2.5">
                  <div className="flex flex-col gap-2">
                    <label className="inline-flex items-center gap-2 text-xs sm:text-sm font-bold text-[#2D251E] cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={includeMicInTabMode}
                        onChange={(e) => setIncludeMicInTabMode(e.target.checked)}
                        className="w-4 h-4 accent-[#C48E63] rounded"
                      />
                      <span>同時錄入我的麥克風聲音（若整場只聽不發言可取消勾選，錄音更乾淨）</span>
                    </label>
                    <label className="inline-flex items-center gap-2 text-xs sm:text-sm font-bold text-[#2D251E] cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={includeLightScreenVideo}
                        onChange={(e) => setIncludeLightScreenVideo(e.target.checked)}
                        className="w-4 h-4 accent-[#C48E63] rounded"
                      />
                      <span>
                        🎞️ 同步附帶超輕量會議畫面（1 秒 1 幀清晰投影片，方便會後請 AI 依妳標記的節點自動截圖存檔！）
                      </span>
                    </label>
                  </div>
                  <div className="text-xs text-[#5C5044] bg-[#FAF8F3] border border-[#DDD7C9] rounded-xl px-3 py-2 leading-relaxed">
                    💡 <strong>點開始後只要 2 秒鐘：</strong>在彈出視窗上方點{' '}
                    <span className="underline decoration-[#F2CA62] decoration-2 font-bold text-[#2D251E]">
                      「Chrome 分頁」
                    </span>{' '}
                    選取 Google Meet 分頁，並確認左下角{' '}
                    <span className="underline decoration-[#F2CA62] decoration-2 font-bold text-[#2D251E]">
                      「✅ 同時分享分頁音訊」
                    </span>{' '}
                    有打勾就可以囉！
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Start Button OR Live Recording Console */}
          {!isBusyRecording ? (
            <button
              type="button"
              disabled={recState === 'starting'}
              onClick={startRecording}
              className="w-full butter-btn py-4 px-6 text-base sm:text-lg font-black flex items-center justify-center gap-2.5 disabled:opacity-60"
            >
              <span className="w-3.5 h-3.5 rounded-full bg-[#C83D33]" />
              <span>
                {recState === 'starting'
                  ? '正在準備收音裝置...'
                  : mode === 'tab_plus_mic'
                    ? '開始錄製線上會議（選取 Meet 分頁）'
                    : '開始會議室麥克風錄音'}
              </span>
            </button>
          ) : (
            <div className="cream-subcard p-4 sm:p-5 space-y-4 border-2 border-[#C48E63]">
              {/* Live Timer & Status Row */}
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2.5">
                  <span
                    className={`w-3.5 h-3.5 rounded-full ${
                      recState === 'recording' ? 'bg-[#C83D33] anim-rec-dot' : 'bg-[#C48E63]'
                    }`}
                  />
                  <span className="text-2xl sm:text-3xl font-black tabular-nums text-[#2D251E]">
                    {formatDuration(elapsedSec)}
                  </span>
                  <span className="px-2.5 py-1 rounded-full bg-[#FAF8F3] border border-[#DDD7C9] text-xs font-bold text-[#5C5044]">
                    {recState === 'recording' ? '錄音中・每 5 秒自動存檔' : '已暫停'}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-xs font-bold text-[#5C5044]">
                  <span>大小：{formatBytes(liveBytes)}</span>
                  {wakeLockActive && (
                    <span className="px-2 py-0.5 rounded-lg bg-[#F2CA62]/40 text-[#2D251E]">
                      ☀️ 防休眠中
                    </span>
                  )}
                </div>
              </div>

              {/* Dual Live Audio Level Meters */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 bg-[#FAF8F3] p-3.5 rounded-2xl border border-[#DDD7C9]">
                {mode === 'tab_plus_mic' && (
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between text-xs font-bold text-[#5C5044]">
                      <span>🔊 Meet 分頁音訊輸入</span>
                      <span>{tabLevel > 3 ? '有聲音 ✓' : '安靜'}</span>
                    </div>
                    <div className="h-2.5 rounded-full bg-[#ECE8DF] overflow-hidden">
                      <div
                        className="h-full bg-[#F2CA62] transition-all duration-75 rounded-full"
                        style={{ width: `${Math.max(4, tabLevel)}%` }}
                      />
                    </div>
                  </div>
                )}

                {(mode === 'mic_only' || includeMicInTabMode) && (
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between text-xs font-bold text-[#5C5044]">
                      <span>🎙️ 我的麥克風輸入</span>
                      <button
                        type="button"
                        onClick={toggleLiveMicMute}
                        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-lg border text-[11px] font-extrabold ${
                          isMicMutedLive
                            ? 'bg-[#C83D33]/15 border-[#C83D33]/40 text-[#912720]'
                            : 'bg-[#EFECE4] border-[#DDD7C9] text-[#2D251E]'
                        }`}
                      >
                        {isMicMutedLive ? (
                          <>
                            <MicOff className="w-3 h-3" /> 麥克風已靜音（點此恢復）
                          </>
                        ) : (
                          <>
                            <Mic className="w-3 h-3" /> 收音中（點此單獨靜音麥克風）
                          </>
                        )}
                      </button>
                    </div>
                    <div className="h-2.5 rounded-full bg-[#ECE8DF] overflow-hidden">
                      <div
                        className="h-full bg-[#C48E63] transition-all duration-75 rounded-full"
                        style={{ width: `${isMicMutedLive ? 0 : Math.max(4, micLevel)}%` }}
                      />
                    </div>
                  </div>
                )}
              </div>

              {/* Timestamped Quick Notes during Meeting */}
              <div className="bg-[#FAF8F3] p-3.5 rounded-2xl border border-[#DDD7C9] space-y-2.5">
                <div className="flex items-center justify-between flex-wrap gap-1.5">
                  <span className="text-xs font-extrabold text-[#5C5044] flex items-center gap-1">
                    <Tag className="w-3.5 h-3.5 text-[#C48E63]" />
                    會議中隨手打重點時間戳（轉逐字稿時會一起附上！）
                  </span>
                  <div className="flex flex-wrap gap-1">
                    {QUICK_STAMP_TAGS.map((t) => (
                      <button
                        key={t}
                        type="button"
                        onClick={() => addLiveTimestampNote(t)}
                        className="px-2 py-0.5 rounded-lg bg-[#EFECE4] hover:bg-[#F2CA62]/40 text-[11px] font-bold text-[#2D251E] border border-[#DDD7C9]"
                      >
                        + {t}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="flex gap-2">
                  <input
                    type="text"
                    value={noteInput}
                    onChange={(e) => setNoteInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        addLiveTimestampNote();
                      }
                    }}
                    placeholder={`在 [${formatDuration(elapsedSec)}] 記重點（打「截圖...」會自動抓當下畫面！）`}
                    className="flex-1 px-3 py-2 rounded-xl bg-[#EFECE4]/70 border border-[#DDD7C9] text-xs sm:text-sm font-bold text-[#2D251E] placeholder:text-[#8A7E70] focus:outline-none focus:border-[#C48E63]"
                  />
                  {mode === 'tab_plus_mic' && (
                    <button
                      type="button"
                      onClick={() => addLiveTimestampNote(undefined, true)}
                      className="butter-btn px-3 py-2 text-xs font-black shrink-0 inline-flex items-center gap-1"
                      title="標記時間戳並立刻拍下目前會議分頁畫面"
                    >
                      <Camera className="w-3.5 h-3.5" />
                      <span>截圖標記</span>
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => addLiveTimestampNote()}
                    className="soft-pill-btn px-3 py-2 text-xs font-extrabold shrink-0"
                  >
                    📌 標記
                  </button>
                </div>

                {liveNotes.length > 0 && (
                  <div className="max-h-36 overflow-y-auto space-y-1.5 pt-1">
                    {liveNotes.map((n) => (
                      <div
                        key={n.id}
                        className="text-xs text-[#5C5044] flex items-center justify-between gap-2 bg-[#EFECE4]/60 px-2.5 py-1.5 rounded-lg"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="font-black text-[#C48E63] tabular-nums shrink-0">
                            [{formatDuration(n.elapsedSec)}]
                          </span>
                          <span className="text-[#2D251E] font-medium truncate">{n.label}</span>
                        </div>
                        {n.hasLocalSnapshot && (
                          <button
                            type="button"
                            onClick={() => handleViewOrDownloadNoteSnapshot(n)}
                            className="px-2 py-0.5 rounded-md bg-[#F2CA62]/50 text-[#2D251E] text-[11px] font-extrabold shrink-0"
                          >
                            🖼️ 下載截圖
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Pause & Stop Controls */}
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 pt-1">
                <button
                  type="button"
                  onClick={togglePauseResume}
                  className="sm:col-span-2 soft-pill-btn py-3.5 px-4 text-sm font-black flex items-center justify-center gap-2"
                >
                  {recState === 'recording' ? (
                    <>
                      <Pause className="w-4 h-4 text-[#5C5044]" /> 暫停錄音
                    </>
                  ) : (
                    <>
                      <Play className="w-4 h-4 text-[#C48E63]" /> 繼續錄音
                    </>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => stopRecording(false)}
                  className="sm:col-span-3 caramel-btn py-3.5 px-5 text-sm sm:text-base font-black flex items-center justify-center gap-2"
                >
                  <Square className="w-4 h-4 fill-current" />
                  <span>結束並儲存音檔</span>
                </button>
              </div>
            </div>
          )}
        </section>

        {/* Saved Recordings Vault */}
        <section className="cream-card p-5 sm:p-6 space-y-4">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2">
              <HardDrive className="w-5 h-5 text-[#C48E63]" />
              <h2 className="text-base sm:text-lg font-black text-[#2D251E]">
                會議錄音庫（共 {vault.records.length} 筆）
              </h2>
            </div>

            <button
              type="button"
              onClick={handleOpenDriveFolder}
              className="soft-pill-btn px-3 py-1.5 text-xs font-extrabold flex items-center gap-1.5 text-[#5C5044]"
            >
              <FolderOpen className="w-3.5 h-3.5 text-[#C48E63]" />
              <span>開啟 Google Drive 錄音資料夾</span>
            </button>
          </div>

          {vault.records.length === 0 ? (
            <div className="py-8 text-center flex flex-col items-center justify-center space-y-2.5">
              <BoboEmptyStageBadge className="w-32 h-24 anim-gentle-bob" />
              <p className="text-sm font-bold text-[#5C5044]">
                目前還沒有會議錄音檔喔！
              </p>
              <p className="text-xs text-[#8A7E70] max-w-md leading-relaxed">
                錄完音後可在這裡一鍵下載 `.webm` 輕量音檔、打開雲端資料夾拖曳上傳，並一鍵複製轉逐字稿指令。
              </p>
            </div>
          ) : (
            <div className="space-y-3.5">
              {vault.records.map((rec) => {
                const hasBlobHere = localBlobIds.has(rec.id);
                const previewUrl = activeAudioUrls[rec.id];
                const isEditing = editingRecordId === rec.id;

                return (
                  <article
                    key={rec.id}
                    className="cream-subcard p-4 space-y-3 transition hover:border-[#C48E63]/60"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="space-y-1 min-w-0 flex-1">
                        {isEditing ? (
                          <div className="flex items-center gap-2">
                            <input
                              type="text"
                              value={editingTitleDraft}
                              onChange={(e) => setEditingTitleDraft(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') handleSaveEditedTitle(rec.id);
                              }}
                              className="flex-1 px-3 py-1.5 rounded-xl bg-[#FAF8F3] border border-[#C48E63] text-sm font-bold"
                              autoFocus
                            />
                            <button
                              type="button"
                              onClick={() => handleSaveEditedTitle(rec.id)}
                              className="butter-btn px-3 py-1.5 text-xs font-black"
                            >
                              儲存
                            </button>
                          </div>
                        ) : (
                          <div className="flex items-center gap-2 flex-wrap">
                            <h3
                              onClick={() => {
                                setEditingRecordId(rec.id);
                                setEditingTitleDraft(rec.title);
                              }}
                              className="font-black text-sm sm:text-base text-[#2D251E] cursor-pointer hover:underline"
                              title="點擊修改會議名稱"
                            >
                              {rec.title}
                            </h3>
                            <span className="px-2 py-0.5 rounded-full bg-[#FAF8F3] border border-[#DDD7C9] text-[11px] font-bold text-[#5C5044]">
                              {rec.mode === 'tab_plus_mic' ? '💻 分頁+麥克風' : '🏢 純麥克風'}
                            </span>
                            {hasBlobHere ? (
                              <span className="px-2 py-0.5 rounded-full bg-[#F2CA62]/40 text-[11px] font-bold text-[#2D251E]">
                                💾 音檔存於此裝置
                              </span>
                            ) : (
                              <span className="px-2 py-0.5 rounded-full bg-[#ECE8DF] text-[11px] font-bold text-[#8A7E70]">
                                ☁️ 跨裝置同步紀錄
                              </span>
                            )}
                          </div>
                        )}

                        <p className="text-xs text-[#5C5044]">
                          📅 {formatDateTimeLabel(rec.startedAt)} ・ ⏱️{' '}
                          <strong>{formatDuration(rec.durationSec)}</strong> ・ 📦{' '}
                          <strong>{formatBytes(rec.sizeBytes)}</strong> ・ 檔名：
                          <code className="text-[11px] bg-[#FAF8F3] px-1.5 py-0.5 rounded border border-[#DDD7C9] ml-1">
                            {rec.fileName}
                          </code>
                        </p>
                      </div>

                      <button
                        type="button"
                        onClick={() => handleDeleteRecord(rec.id)}
                        className={`px-2.5 py-1.5 rounded-xl text-xs font-bold flex items-center gap-1 shrink-0 transition ${
                          confirmDeleteId === rec.id
                            ? 'bg-[#C83D33] text-white'
                            : 'text-[#8A7E70] hover:bg-[#FAF8F3] hover:text-[#C83D33]'
                        }`}
                        title="刪除錄音"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        {confirmDeleteId === rec.id && <span>確定刪除？</span>}
                      </button>
                    </div>

                    {/* Timestamped Notes Summary */}
                    {rec.notes && rec.notes.length > 0 && (
                      <div className="bg-[#FAF8F3] rounded-xl p-2.5 border border-[#DDD7C9] space-y-1">
                        <div className="text-[11px] font-extrabold text-[#8A7E70]">
                          📌 會議重點時間戳：
                        </div>
                        {rec.notes.map((n) => (
                          <div
                            key={n.id}
                            className="text-xs text-[#2D251E] flex items-center justify-between gap-2"
                          >
                            <div className="flex items-center gap-2 min-w-0">
                              <span className="font-black text-[#C48E63] tabular-nums shrink-0">
                                [{formatDuration(n.elapsedSec)}]
                              </span>
                              <span className="truncate">{n.label}</span>
                            </div>
                            {(n.hasLocalSnapshot || n.wantsScreenshot) && (
                              <button
                                type="button"
                                onClick={() => handleViewOrDownloadNoteSnapshot(n, rec.title)}
                                className="px-2 py-0.5 rounded-md bg-[#F2CA62]/45 hover:bg-[#F2CA62] text-[#2D251E] text-[11px] font-extrabold shrink-0"
                              >
                                {n.hasLocalSnapshot ? '🖼️ 下載截圖' : '📸 已標記請 AI 截圖'}
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Audio Player */}
                    {hasBlobHere && (
                      <div>
                        {previewUrl ? (
                          <audio
                            controls
                            src={previewUrl}
                            className="w-full h-10 rounded-xl"
                            preload="metadata"
                          />
                        ) : (
                          <button
                            type="button"
                            onClick={() => handleLoadAudioPreview(rec.id)}
                            className="soft-pill-btn px-3 py-1.5 text-xs font-bold inline-flex items-center gap-1.5 text-[#5C5044]"
                          >
                            <Play className="w-3.5 h-3.5 text-[#C48E63]" />
                            載入音訊播放器試聽
                          </button>
                        )}
                      </div>
                    )}

                    {/* Action Buttons: 1. Download -> 2. Attach in Chat or Drop in Drive -> 3. Copy Prompt */}
                    <p className="text-[11px] text-[#8A7E70] font-bold pt-0.5">
                      💡 錄音檔存在妳的瀏覽器本機：請先點「1. 下載音檔」，再直接把檔案拖進對話框（或丟進「2. Drive 資料夾」），最後貼上「3. 複製指令」即可！
                    </p>
                    <div className="flex flex-wrap items-center gap-2 pt-0.5">
                      {hasBlobHere && (
                        <button
                          type="button"
                          onClick={() => handleDownloadRecord(rec)}
                          className="butter-btn px-3.5 py-2 text-xs font-black inline-flex items-center gap-1.5"
                        >
                          <Download className="w-3.5 h-3.5" />
                          <span>1. 下載音檔 ({formatBytes(rec.sizeBytes)})</span>
                        </button>
                      )}

                      <button
                        type="button"
                        onClick={handleOpenDriveFolder}
                        className="soft-pill-btn px-3.5 py-2 text-xs font-extrabold inline-flex items-center gap-1.5"
                      >
                        <Upload className="w-3.5 h-3.5 text-[#C48E63]" />
                        <span>2. 開啟 Drive 資料夾丟入音檔</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => handleCopyAiPrompt(rec)}
                        className="soft-pill-btn px-3.5 py-2 text-xs font-extrabold inline-flex items-center gap-1.5"
                      >
                        {copiedId === rec.id ? (
                          <>
                            <Check className="w-3.5 h-3.5 text-emerald-700" />
                            <span>已複製指令！</span>
                          </>
                        ) : (
                          <>
                            <Copy className="w-3.5 h-3.5 text-[#5C5044]" />
                            <span>3. 複製轉逐字稿指令</span>
                          </>
                        )}
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      </main>

      {/* Settings & Cloud Sync Modal */}
      {showSettingsModal && (
        <div className="fixed inset-0 z-50 bg-[#2D251E]/40 backdrop-blur-xs flex items-center justify-center p-4 overflow-y-auto">
          <div className="cream-card max-w-lg w-full p-5 sm:p-6 space-y-5 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-[#DDD7C9] pb-3">
              <div className="flex items-center gap-2">
                <Cloud className="w-5 h-5 text-[#C48E63]" />
                <h3 className="text-base sm:text-lg font-black text-[#2D251E]">
                  跨瀏覽器雲端同步＆資料夾設定
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setShowSettingsModal(false)}
                className="soft-pill-btn p-1.5 text-[#5C5044]"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* 1. Google Drive Target Folder URL */}
            <div className="space-y-2">
              <label className="block text-xs font-extrabold text-[#5C5044]">
                📁 專屬 Google Drive 錄音上傳資料夾連結
              </label>
              <div className="flex gap-2">
                <input
                  type="url"
                  value={driveUrlDraft}
                  onChange={(e) => setDriveUrlDraft(e.target.value)}
                  placeholder="https://drive.google.com/drive/folders/..."
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  className="flex-1 px-3 py-2 rounded-xl bg-[#EFECE4] border border-[#DDD7C9] text-xs font-bold text-[#2D251E]"
                />
                <button
                  type="button"
                  onClick={handleSaveDriveUrl}
                  className="butter-btn px-3.5 py-2 text-xs font-black shrink-0"
                >
                  儲存連結
                </button>
              </div>
              <p className="text-[11px] text-[#8A7E70]">
                設定後，點選「開啟 Drive 資料夾」就會直接跳轉到妳專屬的 Meet_Recordings 資料夾！
              </p>
            </div>

            {/* 2. Passcode Cloud Sync */}
            <form onSubmit={handleBindPasscode} className="cream-subcard p-4 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-extrabold text-[#2D251E] flex items-center gap-1.5">
                  <Lock className="w-3.5 h-3.5 text-[#C48E63]" />
                  通行碼加密同步（Safari ↔ 主畫面 App ↔ 電腦互通）
                </span>
                {vaultBadge && (
                  <span className="px-2 py-0.5 rounded-lg bg-[#FAF8F3] border border-[#DDD7C9] text-xs font-bold">
                    {vaultBadge}
                  </span>
                )}
              </div>
              <p className="text-[11px] text-[#5C5044] leading-relaxed">
                輸入自訂通行碼，會議清單、重點時間戳與 Drive 資料夾連結會經 AES-GCM 加密同步；原始大型音檔則安全保存在錄音當下裝置的 IndexedDB。
              </p>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <input
                    type={showPasscode ? 'text' : 'password'}
                    value={passcodeInput}
                    onChange={(e) => setPasscodeInput(e.target.value)}
                    placeholder="輸入自訂同步通行碼..."
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    className="w-full pl-3 pr-9 py-2 rounded-xl bg-[#FAF8F3] border border-[#DDD7C9] text-xs sm:text-sm font-bold text-[#2D251E]"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPasscode((s) => !s)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[#8A7E70]"
                    aria-label="顯示或隱藏通行碼"
                  >
                    {showPasscode ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                <button type="submit" className="butter-btn px-4 py-2 text-xs font-black shrink-0">
                  綁定同步
                </button>
              </div>
            </form>

            {/* 3. Custom Meeting Presets */}
            <div className="space-y-2">
              <label className="block text-xs font-extrabold text-[#5C5044]">
                🏷️ 管理常用會議名稱標籤
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={newPresetDraft}
                  onChange={(e) => setNewPresetDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleAddPreset();
                    }
                  }}
                  placeholder="新增常用會議名稱..."
                  className="flex-1 px-3 py-2 rounded-xl bg-[#EFECE4] border border-[#DDD7C9] text-xs font-bold"
                />
                <button
                  type="button"
                  onClick={handleAddPreset}
                  className="soft-pill-btn px-3 py-2 text-xs font-extrabold inline-flex items-center gap-1"
                >
                  <Plus className="w-3.5 h-3.5" /> 新增
                </button>
              </div>
              <div className="flex flex-wrap gap-1.5 pt-1">
                {vault.presets.map((p) => (
                  <span
                    key={p}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-[#EFECE4] border border-[#DDD7C9] text-xs font-bold"
                  >
                    {p}
                    <button
                      type="button"
                      onClick={() => handleRemovePreset(p)}
                      className="text-[#8A7E70] hover:text-[#C83D33]"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ))}
              </div>
            </div>

            {/* 4. Local History Snapshots & JSON Backup */}
            <div className="border-t border-[#DDD7C9] pt-4 space-y-3">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <span className="text-xs font-extrabold text-[#5C5044] flex items-center gap-1.5">
                  <History className="w-3.5 h-3.5 text-[#C48E63]" />
                  🛟 本機歷史快照救援 ＆ JSON 備份
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleExportJsonBackup}
                    className="soft-pill-btn px-2.5 py-1.5 text-xs font-bold"
                  >
                    下載 .json 備份
                  </button>
                  <label className="soft-pill-btn px-2.5 py-1.5 text-xs font-bold cursor-pointer">
                    匯入 .json
                    <input
                      type="file"
                      accept="application/json,.json"
                      onChange={handleImportJsonBackup}
                      className="hidden"
                    />
                  </label>
                </div>
              </div>

              {snapshots.length > 0 && (
                <div className="space-y-1.5 max-h-32 overflow-y-auto">
                  {snapshots.map((snap) => (
                    <div
                      key={snap.id}
                      className="flex items-center justify-between bg-[#EFECE4] px-3 py-1.5 rounded-xl text-xs"
                    >
                      <span className="text-[#5C5044] font-medium">
                        {formatDateTimeLabel(snap.savedAt)}（{snap.recordCount} 筆紀錄）
                      </span>
                      <button
                        type="button"
                        onClick={() => handleRestoreSnapshot(snap)}
                        className="font-extrabold text-[#C48E63] hover:underline"
                      >
                        合併還原
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
