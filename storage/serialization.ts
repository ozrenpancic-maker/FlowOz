import type { SavedMeasurement } from '../domain/measurement';
import type { Site } from '../domain/types';
import { SCHEMA_VERSION } from './migrations';

/**
 * Document envelope. Payloads are stored as JSON text with the schema version
 * that wrote them, so an older record stays readable after an upgrade instead
 * of failing to parse.
 */
export interface DocumentEnvelope<T> {
  collection: string;
  id: string;
  schemaVersion: number;
  createdAt: string;
  updatedAt: string;
  payload: T;
}

export const COLLECTIONS = {
  settings: 'settings',
  sites: 'sites',
  measurements: 'measurements',
  liveSessions: 'live_sessions',
} as const;

export type CollectionName = (typeof COLLECTIONS)[keyof typeof COLLECTIONS];

export class SerializationError extends Error {
  constructor(
    message: string,
    readonly collection: string,
    readonly id: string,
    readonly cause?: unknown
  ) {
    super(message);
    this.name = 'SerializationError';
  }
}

/**
 * Serialise a payload. Float32Array (SSIV luminance planes never reach storage,
 * but vectors may carry typed arrays in future) and undefined values are not
 * valid JSON, so this fails loudly rather than writing a truncated record.
 */
export function serialise<T>(collection: string, id: string, payload: T): string {
  try {
    const text = JSON.stringify(payload);
    if (typeof text !== 'string') {
      throw new Error('payload serialised to a non-string');
    }
    return text;
  } catch (error) {
    throw new SerializationError('Could not serialise document', collection, id, error);
  }
}

export function deserialise<T>(collection: string, id: string, text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new SerializationError('Could not parse stored document', collection, id, error);
  }
}

/** Fields the saved-measurement list is indexed by. */
export interface MeasurementIndexRow {
  id: string;
  siteId: string | null;
  createdAt: string;
  method: string;
  status: string;
  flowM3s: number | null;
  confidence: string;
}

export function indexRow(measurement: SavedMeasurement): MeasurementIndexRow {
  return {
    id: measurement.id,
    siteId: measurement.siteId ?? null,
    createdAt: measurement.createdAt,
    method: measurement.method,
    status: measurement.processingStatus,
    // A withheld discharge stays null in the index; it is never indexed as 0.
    flowM3s: typeof measurement.flowM3s === 'number' ? measurement.flowM3s : null,
    confidence: measurement.confidence,
  };
}

export function envelope<T>(
  collection: CollectionName,
  id: string,
  payload: T,
  createdAt: string,
  updatedAt: string
): DocumentEnvelope<T> {
  return { collection, id, schemaVersion: SCHEMA_VERSION, createdAt, updatedAt, payload };
}

/** Type guards used when reading documents back after a restart. */
export function isSavedMeasurement(value: unknown): value is SavedMeasurement {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Partial<SavedMeasurement>;
  return (
    typeof record.id === 'string' &&
    typeof record.createdAt === 'string' &&
    typeof record.depth === 'number' &&
    typeof record.method === 'string' &&
    typeof record.measurementVersion === 'number' &&
    typeof record.raw === 'object' &&
    record.raw !== null
  );
}

export function isSite(value: unknown): value is Site {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Partial<Site>;
  return (
    typeof record.id === 'string' &&
    typeof record.name === 'string' &&
    typeof record.alpha === 'number' &&
    Array.isArray(record.calibrationPoints)
  );
}
