import {
  ActiveCrashSessionMeta,
  MeetingRecordMeta,
  VaultState,
  buildSafeAudioFilename,
  createInitialVaultState,
} from '../types/recorder';
import {
  decryptVaultPayload,
  deriveVaultIdentity,
  encryptVaultPayload,
  getPasscodeFallbackVariants,
  normalizePasscode,
} from './cryptoVault';

const LOCAL_STATE_KEY = 'bobomeet_state_v1';
const LAST_NONEMPTY_STATE_KEY = 'bobomeet_last_nonempty_v1';
const LOCAL_PASSCODE_KEY = 'bobomeet_saved_passcode_v1';

const TEXTDB_UPDATE_URL = 'https://api.textdb.online/update/';
const TEXTDB_READ_URL = 'https://textdb.online';
const TEXTDB_DEV_API_URL = 'https://textdb.dev/api/data';
const NTFY_BASE_URL = 'https://ntfy.sh';

const IDB_NAME = 'BoboMeetDB';
const IDB_KV_STORE = 'kv';
const IDB_AUDIO_STORE = 'audio_blobs';
const IDB_CRASH_CHUNKS_STORE = 'active_chunks';

const IDB_STATE_KEY = 'vault_state_v1';
const IDB_PASS_KEY = 'saved_passcode_v1';
const IDB_SNAPSHOTS_KEY = 'history_snapshots_v1';
const IDB_ACTIVE_SESSION_KEY = 'active_session_meta_v1';
const IDB_TIMEOUT_MS = 8000;

const CLOUD_CHUNK_PREFIX = 'BMCHUNK1:';
const CLOUD_CHUNK_MAX_CHARS = 40000;
const LOCALSTORAGE_MAX_INLINE_CHARS = 80000;

export interface LocalHistorySnapshot {
  id: string;
  savedAt: number;
  recordCount: number;
  stateJson: string;
}

export async function requestPersistentStorage(): Promise<void> {
  try {
    if (typeof navigator !== 'undefined' && navigator.storage?.persist) {
      await Promise.race([
        navigator.storage.persist(),
        new Promise<void>((resolve) => setTimeout(resolve, 1200)),
      ]);
    }
  } catch {
    // Ignore unsupported environments
  }
}

function withIdbTimeout<T>(promise: Promise<T>, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(fallback);
      }
    }, IDB_TIMEOUT_MS);

    promise
      .then((val) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(val);
        }
      })
      .catch(() => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(fallback);
        }
      });
  });
}

let cachedDbPromise: Promise<IDBDatabase | null> | null = null;

function openIdb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  if (cachedDbPromise) return cachedDbPromise;

  const rawPromise = new Promise<IDBDatabase | null>((resolve) => {
    try {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_KV_STORE)) {
          db.createObjectStore(IDB_KV_STORE);
        }
        if (!db.objectStoreNames.contains(IDB_AUDIO_STORE)) {
          db.createObjectStore(IDB_AUDIO_STORE);
        }
        if (!db.objectStoreNames.contains(IDB_CRASH_CHUNKS_STORE)) {
          db.createObjectStore(IDB_CRASH_CHUNKS_STORE);
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => {
          db.close();
          cachedDbPromise = null;
        };
        db.onclose = () => {
          cachedDbPromise = null;
        };
        resolve(db);
      };
      req.onerror = () => {
        cachedDbPromise = null;
        resolve(null);
      };
      req.onblocked = () => {
        cachedDbPromise = null;
        resolve(null);
      };
    } catch {
      cachedDbPromise = null;
      resolve(null);
    }
  });

  cachedDbPromise = withIdbTimeout(rawPromise, null).then((db) => {
    if (!db) cachedDbPromise = null;
    return db;
  });
  return cachedDbPromise;
}

async function idbPutAny(storeName: string, key: string, value: unknown): Promise<void> {
  const db = await openIdb();
  if (!db) return;
  const op = new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      cachedDbPromise = null;
      resolve();
    }
  });
  await withIdbTimeout(op, undefined);
}

async function idbGetAny<T>(storeName: string, key: string): Promise<T | null> {
  const db = await openIdb();
  if (!db) return null;
  const op = new Promise<T | null>((resolve) => {
    try {
      const tx = db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).get(key);
      req.onsuccess = () => resolve((req.result as T) ?? null);
      req.onerror = () => resolve(null);
    } catch {
      cachedDbPromise = null;
      resolve(null);
    }
  });
  return withIdbTimeout(op, null);
}

async function idbDelete(storeName: string, key: string): Promise<void> {
  const db = await openIdb();
  if (!db) return;
  const op = new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      cachedDbPromise = null;
      resolve();
    }
  });
  await withIdbTimeout(op, undefined);
}

async function idbClearStore(storeName: string): Promise<void> {
  const db = await openIdb();
  if (!db) return;
  const op = new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      cachedDbPromise = null;
      resolve();
    }
  });
  await withIdbTimeout(op, undefined);
}

export async function saveAudioBlob(recordId: string, blob: Blob): Promise<void> {
  await idbPutAny(IDB_AUDIO_STORE, recordId, blob);
}

export async function getAudioBlob(recordId: string): Promise<Blob | null> {
  const res = await idbGetAny<Blob>(IDB_AUDIO_STORE, recordId);
  return res instanceof Blob ? res : null;
}

export async function deleteAudioBlob(recordId: string): Promise<void> {
  await idbDelete(IDB_AUDIO_STORE, recordId);
}

export async function listStoredAudioBlobIds(): Promise<Set<string>> {
  const db = await openIdb();
  if (!db) return new Set();
  const op = new Promise<Set<string>>((resolve) => {
    try {
      const tx = db.transaction(IDB_AUDIO_STORE, 'readonly');
      const store = tx.objectStore(IDB_AUDIO_STORE);
      if (typeof store.getAllKeys !== 'function') {
        resolve(new Set());
        return;
      }
      const req = store.getAllKeys();
      req.onsuccess = () => {
        const keys = Array.isArray(req.result) ? req.result.map((k) => String(k)) : [];
        resolve(new Set(keys));
      };
      req.onerror = () => resolve(new Set());
    } catch {
      cachedDbPromise = null;
      resolve(new Set());
    }
  });
  return withIdbTimeout(op, new Set());
}

/**
 * 5-Second Crash-Proof Chunk Vault:
 * Every 5s chunk during an active meeting is persisted immediately into IndexedDB.
 */
export async function startCrashRecoverySession(meta: ActiveCrashSessionMeta): Promise<void> {
  await idbClearStore(IDB_CRASH_CHUNKS_STORE);
  await idbPutAny(IDB_KV_STORE, IDB_ACTIVE_SESSION_KEY, JSON.stringify(meta));
}

export async function appendCrashRecoveryChunk(
  sessionId: string,
  chunkIndex: number,
  chunkBlob: Blob,
  updatedMeta: ActiveCrashSessionMeta
): Promise<void> {
  await idbPutAny(IDB_CRASH_CHUNKS_STORE, `${sessionId}_${chunkIndex}`, chunkBlob);
  await idbPutAny(IDB_KV_STORE, IDB_ACTIVE_SESSION_KEY, JSON.stringify(updatedMeta));
}

export async function updateCrashRecoveryMetaOnly(updatedMeta: ActiveCrashSessionMeta): Promise<void> {
  await idbPutAny(IDB_KV_STORE, IDB_ACTIVE_SESSION_KEY, JSON.stringify(updatedMeta));
}

export async function clearCrashRecoverySession(): Promise<void> {
  await idbDelete(IDB_KV_STORE, IDB_ACTIVE_SESSION_KEY);
  await idbClearStore(IDB_CRASH_CHUNKS_STORE);
}

export async function checkPendingCrashRecoverySession(): Promise<ActiveCrashSessionMeta | null> {
  const raw = await idbGetAny<string>(IDB_KV_STORE, IDB_ACTIVE_SESSION_KEY);
  if (!raw || typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw) as ActiveCrashSessionMeta;
    if (parsed && parsed.sessionId && parsed.chunkCount > 0) {
      return parsed;
    }
  } catch {
    // ignore corrupt meta
  }
  return null;
}

export async function recoverCrashedSessionToRecord(
  meta: ActiveCrashSessionMeta
): Promise<MeetingRecordMeta | null> {
  const chunks: Blob[] = [];
  for (let i = 0; i < meta.chunkCount; i++) {
    const part = await idbGetAny<Blob>(IDB_CRASH_CHUNKS_STORE, `${meta.sessionId}_${i}`);
    if (part instanceof Blob && part.size > 0) {
      chunks.push(part);
    }
  }
  if (chunks.length === 0) {
    await clearCrashRecoverySession();
    return null;
  }
  const fullBlob = new Blob(chunks, { type: meta.mimeType || 'audio/webm' });
  const recordId = `rec_${meta.startedAt}_recovered`;
  await saveAudioBlob(recordId, fullBlob);
  await clearCrashRecoverySession();

  const durationSec = Math.max(
    1,
    meta.elapsedSec || Math.round((meta.lastChunkAt - meta.startedAt) / 1000)
  );
  return {
    id: recordId,
    title: `${meta.title || '未命名會議'} (自動救援)`,
    mode: meta.mode,
    includeMicInTabMode: meta.includeMicInTabMode,
    startedAt: meta.startedAt,
    endedAt: meta.lastChunkAt || Date.now(),
    durationSec,
    sizeBytes: fullBlob.size,
    mimeType: fullBlob.type || meta.mimeType || 'audio/webm',
    fileExt: meta.fileExt || 'webm',
    fileName: buildSafeAudioFilename(meta.title, meta.startedAt, meta.fileExt || 'webm'),
    notes: Array.isArray(meta.notes) ? meta.notes : [],
    updatedAt: Date.now(),
  };
}

export function parseVaultJson(raw: string | null | undefined): VaultState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<VaultState>;
    if (!parsed || typeof parsed !== 'object') return null;
    const base = createInitialVaultState();
    return {
      version: 1,
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
      records: Array.isArray(parsed.records) ? parsed.records : [],
      presets:
        Array.isArray(parsed.presets) && parsed.presets.length > 0
          ? parsed.presets
          : base.presets,
      driveFolderUrl: typeof parsed.driveFolderUrl === 'string' ? parsed.driveFolderUrl : '',
      deletedIds:
        parsed.deletedIds && typeof parsed.deletedIds === 'object' ? parsed.deletedIds : {},
    };
  } catch {
    return null;
  }
}

export function mergeVaultStates(a: VaultState, b: VaultState): VaultState {
  if (a.updatedAt === 0 && b.updatedAt > 0) return b;
  if (b.updatedAt === 0 && a.updatedAt > 0) return a;

  const deletedIds: Record<string, number> = { ...a.deletedIds };
  for (const [id, ts] of Object.entries(b.deletedIds || {})) {
    deletedIds[id] = Math.max(deletedIds[id] || 0, ts);
  }

  const recordMap = new Map<string, MeetingRecordMeta>();
  for (const rec of [...a.records, ...b.records]) {
    const delTs = deletedIds[rec.id] || 0;
    if (delTs >= (rec.updatedAt || rec.endedAt || 0)) {
      continue;
    }
    const existing = recordMap.get(rec.id);
    if (!existing || (rec.updatedAt || 0) >= (existing.updatedAt || 0)) {
      recordMap.set(rec.id, rec);
    }
  }

  const newer = b.updatedAt >= a.updatedAt ? b : a;
  const older = b.updatedAt >= a.updatedAt ? a : b;
  const mergedRecords = Array.from(recordMap.values()).sort((x, y) => y.startedAt - x.startedAt);
  const mergedPresets = Array.from(new Set([...newer.presets, ...older.presets])).slice(0, 12);

  return {
    version: 1,
    updatedAt: Math.max(a.updatedAt, b.updatedAt),
    records: mergedRecords,
    presets: mergedPresets,
    driveFolderUrl: newer.driveFolderUrl || older.driveFolderUrl || '',
    deletedIds,
  };
}

function tryWriteSlimLocalStorage(key: string, state: VaultState): void {
  const fullJson = JSON.stringify(state);
  const payload =
    fullJson.length <= LOCALSTORAGE_MAX_INLINE_CHARS
      ? fullJson
      : JSON.stringify({
          ...state,
          records: state.records.slice(0, 80),
        });
  try {
    localStorage.setItem(key, payload);
  } catch {
    // Shared github.io 5MB localStorage full; IndexedDB retains 100%
  }
}

export function loadLocalVaultSync(): VaultState {
  let primary: VaultState | null = null;
  let backup: VaultState | null = null;
  try {
    primary = parseVaultJson(localStorage.getItem(LOCAL_STATE_KEY));
  } catch {
    primary = null;
  }
  try {
    backup = parseVaultJson(localStorage.getItem(LAST_NONEMPTY_STATE_KEY));
  } catch {
    backup = null;
  }
  if (primary && backup) return mergeVaultStates(primary, backup);
  return primary || backup || createInitialVaultState();
}

export async function hydrateVaultFromIndexedDb(syncBase: VaultState): Promise<VaultState> {
  const idbRaw = await idbGetAny<string>(IDB_KV_STORE, IDB_STATE_KEY);
  const idbState = parseVaultJson(idbRaw);
  if (!idbState) return syncBase;
  return mergeVaultStates(syncBase, idbState);
}

async function appendRollingHistorySnapshot(state: VaultState): Promise<void> {
  if (state.records.length === 0) return;
  try {
    const raw = await idbGetAny<string>(IDB_KV_STORE, IDB_SNAPSHOTS_KEY);
    const list: LocalHistorySnapshot[] = raw ? JSON.parse(raw) : [];
    const safeList = Array.isArray(list) ? list : [];
    const now = Date.now();
    const stateJson = JSON.stringify(state);
    const latest = safeList[0];

    if (latest && now - latest.savedAt < 90_000 && latest.recordCount === state.records.length) {
      safeList[0] = { ...latest, savedAt: now, stateJson };
      await idbPutAny(IDB_KV_STORE, IDB_SNAPSHOTS_KEY, JSON.stringify(safeList.slice(0, 6)));
      return;
    }

    const nextSnap: LocalHistorySnapshot = {
      id: `snap_${now}`,
      savedAt: now,
      recordCount: state.records.length,
      stateJson,
    };
    await idbPutAny(
      IDB_KV_STORE,
      IDB_SNAPSHOTS_KEY,
      JSON.stringify([nextSnap, ...safeList].slice(0, 6))
    );
  } catch {
    // Ignore snapshot write error
  }
}

export async function getHistorySnapshots(): Promise<LocalHistorySnapshot[]> {
  try {
    const raw = await idbGetAny<string>(IDB_KV_STORE, IDB_SNAPSHOTS_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export async function saveVaultLocally(state: VaultState): Promise<void> {
  tryWriteSlimLocalStorage(LOCAL_STATE_KEY, state);
  if (state.records.length > 0 || state.driveFolderUrl) {
    tryWriteSlimLocalStorage(LAST_NONEMPTY_STATE_KEY, state);
  }
  await idbPutAny(IDB_KV_STORE, IDB_STATE_KEY, JSON.stringify(state));
  await appendRollingHistorySnapshot(state);
}

export function loadRememberedPasscodeSync(): string {
  try {
    return normalizePasscode(localStorage.getItem(LOCAL_PASSCODE_KEY) || '');
  } catch {
    return '';
  }
}

export async function loadRememberedPasscodeAsync(): Promise<string> {
  const syncVal = loadRememberedPasscodeSync();
  if (syncVal) return syncVal;
  const idbVal = await idbGetAny<string>(IDB_KV_STORE, IDB_PASS_KEY);
  return normalizePasscode(idbVal || '');
}

export async function saveRememberedPasscode(passcode: string): Promise<void> {
  const clean = normalizePasscode(passcode);
  try {
    if (clean) localStorage.setItem(LOCAL_PASSCODE_KEY, clean);
    else localStorage.removeItem(LOCAL_PASSCODE_KEY);
  } catch {
    // ignore
  }
  if (clean) await idbPutAny(IDB_KV_STORE, IDB_PASS_KEY, clean);
  else await idbDelete(IDB_KV_STORE, IDB_PASS_KEY);
}

/**
 * Dual-Engine Permanent KV Cloud Storage (`textdb.online` + `textdb.dev` mirror)
 */
async function writeTextDbOnlineSingle(key: string, value: string): Promise<boolean> {
  try {
    const body = new URLSearchParams({ key, value }).toString();
    const res = await fetch(TEXTDB_UPDATE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) return false;
    const txt = (await res.text()).trim();
    if (!txt) return true;
    try {
      const parsed = JSON.parse(txt) as { status?: number };
      if (parsed && typeof parsed === 'object' && 'status' in parsed) {
        return Number(parsed.status) === 1;
      }
    } catch {
      // Non-JSON 200 OK fallback
    }
    return true;
  } catch {
    return false;
  }
}

async function writeTextDbDevSingle(key: string, value: string): Promise<boolean> {
  try {
    const res = await fetch(`${TEXTDB_DEV_API_URL}/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload: value }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function writeChunkedToProvider(
  baseKey: string,
  fullValue: string,
  writeSingle: (k: string, v: string) => Promise<boolean>
): Promise<boolean> {
  if (fullValue.length <= CLOUD_CHUNK_MAX_CHARS) {
    return writeSingle(baseKey, fullValue);
  }
  const chunks: string[] = [];
  for (let i = 0; i < fullValue.length; i += CLOUD_CHUNK_MAX_CHARS) {
    chunks.push(fullValue.slice(i, i + CLOUD_CHUNK_MAX_CHARS));
  }
  for (let idx = 1; idx < chunks.length; idx++) {
    if (!(await writeSingle(`${baseKey}_p${idx}`, chunks[idx]))) return false;
  }
  return writeSingle(baseKey, `${CLOUD_CHUNK_PREFIX}${chunks.length}:${chunks[0]}`);
}

async function writePermanentCloud(key: string, value: string): Promise<boolean> {
  const [okOnline, okDev] = await Promise.all([
    writeChunkedToProvider(key, value, writeTextDbOnlineSingle),
    writeChunkedToProvider(key, value, writeTextDbDevSingle),
  ]);
  return okOnline || okDev;
}

async function readTextDbOnlineSingle(key: string): Promise<string | null> {
  try {
    const res = await fetch(`${TEXTDB_READ_URL}/${encodeURIComponent(key)}?t=${Date.now()}`, {
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const text = (await res.text()).trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

async function readTextDbDevSingle(key: string): Promise<string | null> {
  try {
    const res = await fetch(`${TEXTDB_DEV_API_URL}/${encodeURIComponent(key)}?t=${Date.now()}`, {
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const text = (await res.text()).trim();
    if (!text) return null;
    let parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'string') parsed = JSON.parse(parsed);
    if (parsed && typeof parsed === 'object' && 'payload' in parsed) {
      const p = (parsed as { payload?: unknown }).payload;
      return typeof p === 'string' && p.trim().length > 0 ? p.trim() : null;
    }
    return null;
  } catch {
    return null;
  }
}

async function readChunkedFromProvider(
  baseKey: string,
  readSingle: (k: string) => Promise<string | null>
): Promise<string | null> {
  const head = await readSingle(baseKey);
  if (!head) return null;
  if (!head.startsWith(CLOUD_CHUNK_PREFIX)) return head;
  const rest = head.slice(CLOUD_CHUNK_PREFIX.length);
  const colonIdx = rest.indexOf(':');
  if (colonIdx <= 0) return null;
  const totalChunks = Number.parseInt(rest.slice(0, colonIdx), 10);
  const chunk0 = rest.slice(colonIdx + 1);
  if (!Number.isFinite(totalChunks) || totalChunks < 2 || totalChunks > 60) return null;
  const tails = await Promise.all(
    Array.from({ length: totalChunks - 1 }, (_, i) => readSingle(`${baseKey}_p${i + 1}`))
  );
  if (tails.some((p) => !p)) return null;
  return chunk0 + tails.join('');
}

async function readPermanentCloud(key: string): Promise<string | null> {
  const [onlineVal, devVal] = await Promise.all([
    readChunkedFromProvider(key, readTextDbOnlineSingle),
    readChunkedFromProvider(key, readTextDbDevSingle),
  ]);
  return onlineVal || devVal || null;
}

export async function pullVaultFromCloud(
  rawPasscode: string
): Promise<{ matchedPasscode: string; remoteState: VaultState | null; badge: string }> {
  const variants = getPasscodeFallbackVariants(rawPasscode);
  if (variants.length === 0) {
    throw new Error('請輸入通行碼');
  }

  for (const candidate of variants) {
    const id = await deriveVaultIdentity(candidate);
    const cipher = await readPermanentCloud(id.vaultKey);
    if (cipher) {
      try {
        const json = await decryptVaultPayload(cipher, candidate);
        const parsed = parseVaultJson(json);
        if (parsed) {
          return {
            matchedPasscode: candidate,
            remoteState: parsed,
            badge: id.fingerprintBadge,
          };
        }
      } catch {
        // Continue checking variants
      }
    }
  }

  const exactId = await deriveVaultIdentity(variants[0]);
  return {
    matchedPasscode: variants[0],
    remoteState: null,
    badge: exactId.fingerprintBadge,
  };
}

export async function pushVaultToCloud(passcode: string, state: VaultState): Promise<boolean> {
  if (!passcode || state.updatedAt === 0) return false;
  const id = await deriveVaultIdentity(passcode);
  const encrypted = await encryptVaultPayload(JSON.stringify(state), passcode);
  const ok = await writePermanentCloud(id.vaultKey, encrypted);
  if (ok) {
    // Non-blocking SSE ping for instant multi-tab wakeup
    fetch(`${NTFY_BASE_URL}/${encodeURIComponent(id.sseTopic)}`, {
      method: 'POST',
      body: String(state.updatedAt),
    }).catch(() => {});
  }
  return ok;
}

export function subscribeToCloudWakeup(passcode: string, onWakeup: () => void): () => void {
  let es: EventSource | null = null;
  let cancelled = false;

  deriveVaultIdentity(passcode)
    .then((id) => {
      if (cancelled || typeof EventSource === 'undefined') return;
      es = new EventSource(`${NTFY_BASE_URL}/${encodeURIComponent(id.sseTopic)}/sse`);
      es.onmessage = () => {
        onWakeup();
      };
    })
    .catch(() => {});

  return () => {
    cancelled = true;
    if (es) {
      es.close();
      es = null;
    }
  };
}
