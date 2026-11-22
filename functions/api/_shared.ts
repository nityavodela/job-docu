import { ENTRY_TYPES, EVENT_TYPES, type LogRecord } from '../../src/model'

export interface Environment {
  DB: D1Database
  SYNC_TOKEN?: string
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  })
}

export async function readJsonBody(request: Request): Promise<unknown> {
  const contentLength = request.headers.get('Content-Length')
  if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > 256_000)) {
    throw new Error('Request body is too large.')
  }
  const reader = request.body?.getReader()
  if (!reader) throw new Error('Request body is required.')
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > 256_000) {
      await reader.cancel()
      throw new Error('Request body is too large.')
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)) as unknown
  } catch {
    throw new Error('Invalid JSON body.')
  }
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== 24) return false
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value
}

function isDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

function hasOnlyFields(value: Record<string, unknown>, fields: string[]): boolean {
  return Object.keys(value).every((field) => fields.includes(field))
}

export function validateRecord(value: unknown): LogRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const commonFields = ['id', 'kind', 'createdAt', 'createdAtExact', 'updatedAt', 'deleted', 'syncStatus', 'syncPendingSince']
  if (
    typeof record.id !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record.id) ||
    !isIsoTimestamp(record.createdAt) ||
    !isIsoTimestamp(record.updatedAt) ||
    typeof record.deleted !== 'boolean' ||
    (record.createdAtExact !== undefined && (!Number.isSafeInteger(record.createdAtExact) || Number(record.createdAtExact) < 0)) ||
    (record.syncStatus !== undefined && record.syncStatus !== 'pending' && record.syncStatus !== 'synced') ||
    (record.syncPendingSince !== undefined && (!Number.isSafeInteger(record.syncPendingSince) || Number(record.syncPendingSince) < 0))
  ) return null

  if (record.kind === 'entry') {
    const fields = [
      ...commonFields,
      'date',
      'startAt',
      'endAt',
      'type',
      'withWho',
      'forWhat',
      'startedAtExact',
      'endedAtExact',
    ]
    if (
      !hasOnlyFields(record, fields) ||
      !isDate(record.date) ||
      !isIsoTimestamp(record.startAt) ||
      (record.endAt !== null && !isIsoTimestamp(record.endAt)) ||
      typeof record.type !== 'string' ||
      !(ENTRY_TYPES as readonly string[]).includes(record.type) ||
      typeof record.withWho !== 'string' ||
      record.withWho.length > 500 ||
      typeof record.forWhat !== 'string' ||
      record.forWhat.length > 2_000 ||
      (record.startedAtExact !== undefined && (!Number.isSafeInteger(record.startedAtExact) || Number(record.startedAtExact) < 0)) ||
      (record.endedAtExact !== undefined && (!Number.isSafeInteger(record.endedAtExact) || Number(record.endedAtExact) < 0))
    ) return null
    return record as unknown as LogRecord
  }

  if (record.kind === 'event') {
    if (
      !hasOnlyFields(record, [...commonFields, 'occurredAt', 'type']) ||
      !isIsoTimestamp(record.occurredAt) ||
      typeof record.type !== 'string' ||
      !(EVENT_TYPES as readonly string[]).includes(record.type)
    ) return null
    return record as unknown as LogRecord
  }
  return null
}

export function asDatabaseValues(record: LogRecord): unknown[] {
  if (record.kind === 'entry') {
    return [
      record.id,
      record.kind,
      record.date,
      record.startAt,
      record.endAt,
      record.type,
      record.withWho || null,
      record.forWhat || null,
      record.startedAtExact ?? null,
      record.endedAtExact ?? null,
      null,
      record.createdAt,
      record.updatedAt,
      record.deleted ? 1 : 0,
      record.createdAtExact ?? null,
    ]
  }
  return [
    record.id,
    record.kind,
    null,
    null,
    null,
    record.type,
    null,
    null,
    null,
    null,
    record.occurredAt,
    record.createdAt,
    record.updatedAt,
    record.deleted ? 1 : 0,
    record.createdAtExact ?? null,
  ]
}
