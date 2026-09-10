import { Platform } from 'react-native';
import * as LegacyFileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';

/**
 * Android saving and sharing.
 *
 * Saving goes through the Storage Access Framework, so the operator picks the
 * destination folder themselves. Sharing goes through the system chooser. There
 * is no automatic upload, no e-mail sent on the operator's behalf, and no
 * background transfer: an export leaves the device only through an explicit
 * action taken here.
 */

export type ExportErrorCode =
  | 'PERMISSION_DENIED'
  | 'WRITE_FAILED'
  | 'READ_FAILED'
  | 'SHARING_UNAVAILABLE'
  | 'SHARE_FAILED'
  | 'UNSUPPORTED_PLATFORM';

export interface ExportError {
  code: ExportErrorCode;
  messageKey: string;
  detail: string;
}

export type SaveOutcome =
  | { ok: true; uri: string }
  | { ok: true; cancelled: true }
  | { ok: false; error: ExportError };

function exportError(code: ExportErrorCode, detail: string): ExportError {
  return { code, messageKey: `export.error.${code}`, detail };
}

/**
 * Write a text document (CSV) to a folder the operator chooses.
 * A cancelled folder picker is not an error.
 */
export async function saveTextWithSaf(
  fileName: string,
  content: string,
  mimeType = 'text/csv'
): Promise<SaveOutcome> {
  if (Platform.OS !== 'android') {
    return { ok: false, error: exportError('UNSUPPORTED_PLATFORM', `SAF is Android-only, got ${Platform.OS}`) };
  }

  try {
    const permission = await LegacyFileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync();
    if (!permission.granted) {
      // The operator dismissed the picker — that is a choice, not a failure.
      return { ok: true, cancelled: true };
    }

    const target = await LegacyFileSystem.StorageAccessFramework.createFileAsync(
      permission.directoryUri,
      fileName,
      mimeType
    );
    await LegacyFileSystem.writeAsStringAsync(target, content, {
      encoding: LegacyFileSystem.EncodingType.UTF8,
    });
    return { ok: true, uri: target };
  } catch (error) {
    return { ok: false, error: exportError('WRITE_FAILED', describe(error)) };
  }
}

/** Copy an already generated local file (the PDF) into a folder of the operator's choosing. */
export async function saveFileWithSaf(
  sourceUri: string,
  fileName: string,
  mimeType = 'application/pdf'
): Promise<SaveOutcome> {
  if (Platform.OS !== 'android') {
    return { ok: false, error: exportError('UNSUPPORTED_PLATFORM', `SAF is Android-only, got ${Platform.OS}`) };
  }

  let base64: string;
  try {
    base64 = await LegacyFileSystem.readAsStringAsync(sourceUri, {
      encoding: LegacyFileSystem.EncodingType.Base64,
    });
  } catch (error) {
    return { ok: false, error: exportError('READ_FAILED', describe(error)) };
  }

  try {
    const permission = await LegacyFileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync();
    if (!permission.granted) return { ok: true, cancelled: true };

    const target = await LegacyFileSystem.StorageAccessFramework.createFileAsync(
      permission.directoryUri,
      fileName,
      mimeType
    );
    await LegacyFileSystem.writeAsStringAsync(target, base64, {
      encoding: LegacyFileSystem.EncodingType.Base64,
    });
    return { ok: true, uri: target };
  } catch (error) {
    return { ok: false, error: exportError('WRITE_FAILED', describe(error)) };
  }
}

/** Hand the file to the Android system chooser. Never sends anything by itself. */
export async function shareFile(
  uri: string,
  mimeType: string,
  dialogTitle: string
): Promise<{ ok: true } | { ok: false; error: ExportError }> {
  try {
    if (!(await Sharing.isAvailableAsync())) {
      return { ok: false, error: exportError('SHARING_UNAVAILABLE', 'no share target on this device') };
    }
    await Sharing.shareAsync(uri, { mimeType, dialogTitle, UTI: mimeType });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: exportError('SHARE_FAILED', describe(error)) };
  }
}

/** Write a text export into app storage first, so sharing has a real file. */
export async function writeTempTextFile(fileName: string, content: string): Promise<string | null> {
  const base = LegacyFileSystem.cacheDirectory;
  if (!base) return null;
  const uri = `${base}${fileName}`;
  await LegacyFileSystem.writeAsStringAsync(uri, content, {
    encoding: LegacyFileSystem.EncodingType.UTF8,
  });
  return uri;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
