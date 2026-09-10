import * as LegacyFileSystem from 'expo-file-system/legacy';

/**
 * Permanent media storage.
 *
 * A recorded or imported video lands in a cache location that Android may
 * reclaim at any time. Before anything else happens the file is copied into the
 * application document directory, and the copy is verified to exist and to be
 * non-empty. A measurement is never told "video captured" for a file that is
 * not actually there.
 */

export const MEDIA_DIRECTORY = 'flowvision-media';

export type MediaErrorCode =
  | 'NO_DOCUMENT_DIRECTORY'
  | 'SOURCE_UNREADABLE'
  | 'COPY_FAILED'
  | 'COPY_EMPTY'
  | 'COPY_MISSING'
  | 'DELETE_FAILED';

export interface MediaError {
  code: MediaErrorCode;
  messageKey: string;
  detail: string;
}

export interface StoredMedia {
  /** file:// URI inside the application document directory. */
  uri: string;
  sizeBytes: number;
  storedAt: string;
}

export type MediaResult =
  | { ok: true; media: StoredMedia }
  | { ok: false; error: MediaError };

function mediaError(code: MediaErrorCode, detail: string): MediaError {
  return { code, messageKey: `media.error.${code}`, detail };
}

function directoryUri(): string | null {
  const base = LegacyFileSystem.documentDirectory;
  if (!base) return null;
  return `${base}${MEDIA_DIRECTORY}/`;
}

export async function ensureMediaDirectory(): Promise<string | null> {
  const uri = directoryUri();
  if (!uri) return null;
  const info = await LegacyFileSystem.getInfoAsync(uri);
  if (!info.exists) {
    await LegacyFileSystem.makeDirectoryAsync(uri, { intermediates: true });
  }
  return uri;
}

export function buildMediaName(kind: 'video' | 'photo', extension: string, at = new Date()): string {
  const stamp = at
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
  const suffix = Math.random().toString(36).slice(2, 8);
  const safeExtension = extension.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'bin';
  return `${kind}-${stamp}-${suffix}.${safeExtension}`;
}

/**
 * Copy a captured or imported file into permanent storage and verify the copy.
 * Returns a typed error rather than throwing, so the calling screen can show
 * the real reason instead of a blank state.
 */
export async function persistMedia(
  sourceUri: string,
  kind: 'video' | 'photo',
  extension = kind === 'video' ? 'mp4' : 'jpg'
): Promise<MediaResult> {
  if (!sourceUri) {
    return { ok: false, error: mediaError('SOURCE_UNREADABLE', 'empty source URI') };
  }

  const directory = await ensureMediaDirectory().catch(() => null);
  if (!directory) {
    return {
      ok: false,
      error: mediaError('NO_DOCUMENT_DIRECTORY', 'application document directory is unavailable'),
    };
  }

  let sourceInfo: LegacyFileSystem.FileInfo;
  try {
    sourceInfo = await LegacyFileSystem.getInfoAsync(sourceUri);
  } catch (error) {
    return {
      ok: false,
      error: mediaError('SOURCE_UNREADABLE', describe(error)),
    };
  }
  if (!sourceInfo.exists) {
    return { ok: false, error: mediaError('SOURCE_UNREADABLE', `${sourceUri} does not exist`) };
  }

  const target = `${directory}${buildMediaName(kind, extension)}`;
  try {
    await LegacyFileSystem.copyAsync({ from: sourceUri, to: target });
  } catch (error) {
    return { ok: false, error: mediaError('COPY_FAILED', describe(error)) };
  }

  let targetInfo: LegacyFileSystem.FileInfo;
  try {
    targetInfo = await LegacyFileSystem.getInfoAsync(target);
  } catch (error) {
    return { ok: false, error: mediaError('COPY_MISSING', describe(error)) };
  }
  if (!targetInfo.exists) {
    return { ok: false, error: mediaError('COPY_MISSING', `${target} is missing after copy`) };
  }

  const sizeBytes = 'size' in targetInfo && typeof targetInfo.size === 'number' ? targetInfo.size : 0;
  if (sizeBytes <= 0) {
    // A zero-byte copy is a failed copy, whatever the platform reported.
    await LegacyFileSystem.deleteAsync(target, { idempotent: true }).catch(() => undefined);
    return { ok: false, error: mediaError('COPY_EMPTY', `${target} is empty`) };
  }

  return {
    ok: true,
    media: { uri: target, sizeBytes, storedAt: new Date().toISOString() },
  };
}

export async function mediaExists(uri: string): Promise<boolean> {
  try {
    const info = await LegacyFileSystem.getInfoAsync(uri);
    return info.exists;
  } catch {
    return false;
  }
}

/**
 * Delete a media file. The caller must have established that no saved record
 * still references it — the repository's reference count is the authority, so a
 * retry never removes a video another measurement still points at.
 */
export async function deleteMedia(uri: string): Promise<{ ok: true } | { ok: false; error: MediaError }> {
  try {
    await LegacyFileSystem.deleteAsync(uri, { idempotent: true });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: mediaError('DELETE_FAILED', describe(error)) };
  }
}

export async function mediaSize(uri: string): Promise<number | null> {
  try {
    const info = await LegacyFileSystem.getInfoAsync(uri);
    if (!info.exists) return null;
    return 'size' in info && typeof info.size === 'number' ? info.size : null;
  } catch {
    return null;
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
