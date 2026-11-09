import LZString from 'lz-string';

export interface DerivedVaultIdentity {
  passHashHex: string;
  vaultKey: string;
  sseTopic: string;
  fingerprintBadge: string;
}

const FINGERPRINT_EMOJIS = ['🧸', '🍡', '🥐', '🍮', '🍪', '🥛', '🍑', '🌼'];

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x2000;
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, Math.min(i + CHUNK, bytes.length));
    parts.push(String.fromCharCode(...slice));
  }
  return btoa(parts.join(''));
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

export function normalizePasscode(raw: string): string {
  return raw.trim();
}

export function getPasscodeFallbackVariants(raw: string): string[] {
  const exact = normalizePasscode(raw);
  if (!exact) return [];
  const nfkc = exact.normalize('NFKC').trim();
  const toggledFirst =
    nfkc.length > 0
      ? (nfkc[0] === nfkc[0].toLowerCase() ? nfkc[0].toUpperCase() : nfkc[0].toLowerCase()) +
        nfkc.slice(1)
      : nfkc;
  const lower = nfkc.toLowerCase();
  const capFirst = lower.length > 0 ? lower[0].toUpperCase() + lower.slice(1) : lower;
  return Array.from(new Set([exact, nfkc, toggledFirst, lower, capFirst].filter(Boolean)));
}

export async function deriveVaultIdentity(passcode: string): Promise<DerivedVaultIdentity> {
  const normalized = normalizePasscode(passcode);
  if (!normalized) {
    throw new Error('請輸入通行碼');
  }
  const enc = new TextEncoder();
  const hashBuf = await crypto.subtle.digest(
    'SHA-256',
    enc.encode(`bobo_meet_vault_v1:${normalized}`)
  );
  const bytes = new Uint8Array(hashBuf);
  const fullHex = bytesToHex(bytes);
  const keySlice = fullHex.slice(0, 32);
  const sseSlice = fullHex.slice(32, 56);
  const fpA = FINGERPRINT_EMOJIS[bytes[28] % FINGERPRINT_EMOJIS.length];
  const fpB = FINGERPRINT_EMOJIS[bytes[29] % FINGERPRINT_EMOJIS.length];
  const fpCode = fullHex.slice(60, 64).toUpperCase();
  return {
    passHashHex: fullHex,
    vaultKey: `bobomeet_perm_v1_${keySlice}`,
    sseTopic: `bobomeet_sse_v1_${sseSlice}`,
    fingerprintBadge: `${fpA}${fpB} #${fpCode}`,
  };
}

async function deriveAesKey(passcode: string, salt: Uint8Array): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(`bobo_meet_aes_v1:${normalizePasscode(passcode)}`),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt as BufferSource,
      iterations: 60000,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function encryptVaultPayload(plainJson: string, passcode: string): Promise<string> {
  const compressedBytes = LZString.compressToUint8Array(plainJson);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aesKey = await deriveAesKey(passcode, salt);
  const cipherBuf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    aesKey,
    compressedBytes as BufferSource
  );
  const cipherBytes = new Uint8Array(cipherBuf);
  const packed = new Uint8Array(16 + 12 + cipherBytes.length);
  packed.set(salt, 0);
  packed.set(iv, 16);
  packed.set(cipherBytes, 28);
  return `BM2:${bytesToBase64(packed)}`;
}

export async function decryptVaultPayload(payload: string, passcode: string): Promise<string> {
  const trimmed = payload.trim();
  if (!trimmed.startsWith('BM2:')) {
    throw new Error('無效的雲端加密格式');
  }
  const packed = base64ToBytes(trimmed.slice(4));
  if (packed.length < 29) {
    throw new Error('無效的雲端密文長度');
  }
  const salt = packed.slice(0, 16);
  const iv = packed.slice(16, 28);
  const cipherBytes = packed.slice(28);
  const aesKey = await deriveAesKey(passcode, salt);
  const plainBuf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    aesKey,
    cipherBytes as BufferSource
  );
  const decompressed = LZString.decompressFromUint8Array(new Uint8Array(plainBuf));
  if (!decompressed) {
    throw new Error('解壓縮雲端資料失敗');
  }
  return decompressed;
}
