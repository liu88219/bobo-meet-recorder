import { describe, expect, it } from 'vitest';
import {
  decryptVaultPayload,
  deriveVaultIdentity,
  encryptVaultPayload,
  getPasscodeFallbackVariants,
} from '../services/cryptoVault';
import { mergeVaultStates } from '../services/storageAndSync';
import {
  VaultState,
  buildSafeAudioFilename,
  createInitialVaultState,
  formatBytes,
  formatDuration,
} from '../types/recorder';

describe('BoboMeet core utilities & anti-overwrite sync', () => {
  it('formats durations and file sizes cleanly', () => {
    expect(formatDuration(65)).toBe('01:05');
    expect(formatDuration(3661)).toBe('01:01:01');
    expect(formatBytes(512 * 1024)).toBe('512 KB');
    expect(formatBytes(14 * 1024 * 1024)).toBe('14.0 MB');
  });

  it('builds safe clean audio filenames without illegal path characters', () => {
    const ts = new Date(2026, 10, 9, 14, 30).getTime();
    const name = buildSafeAudioFilename('PMO QA: Sync / Weekly?', ts, 'webm');
    expect(name).toBe('Meet_2026-11-09_1430_PMO_QA__Sync___Weekly_.webm');
  });

  it('never lets an unedited default state (updatedAt=0) overwrite cloud records', () => {
    const freshBrowser = createInitialVaultState();
    const cloudState: VaultState = {
      ...createInitialVaultState(),
      updatedAt: 1794200000000,
      driveFolderUrl: 'https://drive.google.com/drive/folders/example1234567890',
      records: [
        {
          id: 'rec_1',
          title: 'PMO QA Sync Weekly',
          mode: 'tab_plus_mic',
          includeMicInTabMode: true,
          startedAt: 1794190000000,
          endedAt: 1794193600000,
          durationSec: 3600,
          sizeBytes: 14500000,
          mimeType: 'audio/webm;codecs=opus',
          fileExt: 'webm',
          fileName: 'Meet_2026-11-09_1000_PMO_QA_Sync_Weekly.webm',
          notes: [],
          updatedAt: 1794193600000,
        },
      ],
    };

    const merged = mergeVaultStates(freshBrowser, cloudState);
    expect(merged.records).toHaveLength(1);
    expect(merged.records[0].title).toBe('PMO QA Sync Weekly');
    expect(merged.driveFolderUrl).toBe(cloudState.driveFolderUrl);
  });

  it('honors deletedIds tombstones during cross-browser merge', () => {
    const stateA: VaultState = {
      ...createInitialVaultState(),
      updatedAt: 1000,
      records: [
        {
          id: 'rec_old',
          title: 'Old Sync',
          mode: 'mic_only',
          includeMicInTabMode: false,
          startedAt: 900,
          endedAt: 950,
          durationSec: 50,
          sizeBytes: 200000,
          mimeType: 'audio/webm',
          fileExt: 'webm',
          fileName: 'old.webm',
          notes: [],
          updatedAt: 950,
        },
      ],
    };

    const stateB: VaultState = {
      ...createInitialVaultState(),
      updatedAt: 2000,
      records: [],
      deletedIds: { rec_old: 1500 },
    };

    const merged = mergeVaultStates(stateA, stateB);
    expect(merged.records).toHaveLength(0);
    expect(merged.deletedIds.rec_old).toBe(1500);
  });

  it('derives deterministic vault keys and encrypts/decrypts BM2 payloads', async () => {
    const id1 = await deriveVaultIdentity('my-secret-pass');
    const id2 = await deriveVaultIdentity('my-secret-pass');
    expect(id1.vaultKey).toBe(id2.vaultKey);
    expect(id1.fingerprintBadge).toBe(id2.fingerprintBadge);

    const variants = getPasscodeFallbackVariants('MyPass123');
    expect(variants).toContain('MyPass123');
    expect(variants).toContain('mypass123');

    const plain = JSON.stringify({ hello: 'Quokka & BOBO', count: 3 });
    const cipher = await encryptVaultPayload(plain, 'my-secret-pass');
    expect(cipher.startsWith('BM2:')).toBe(true);
    const decrypted = await decryptVaultPayload(cipher, 'my-secret-pass');
    expect(decrypted).toBe(plain);
  });
});
