import Dexie, { type EntityTable } from 'dexie'
import { ENTRY_TYPES, EVENT_TYPES, type EntryType, type EventType, type Entry, type LogEvent, type LogRecord } from './model'

export {
  ENTRY_TYPES,
  EVENT_TYPES,
  type Entry,
  type EntryType,
  type EventType,
  type LogEvent,
  type LogRecord,
} from './model'

class WorkLogDatabase extends Dexie {
  records!: EntityTable<LogRecord, 'id'>
  syncMeta!: EntityTable<{ key: string; value: string }, 'key'>

  constructor() {
    super('personal-work-log')
    this.version(1).stores({ records: 'id, kind, date, startAt, occurredAt, deleted' })
    this.version(2)
      .stores({
        records: 'id, kind, date, startAt, occurredAt, deleted, syncStatus, syncPendingSince, updatedAt',
        syncMeta: 'key',
      })
      .upgrade(async (transaction) => {
        const now = Date.now()
        await transaction.table('records').toCollection().modify((record: LogRecord) => {
          record.syncStatus = 'pending'
          const updatedAt = Date.parse(record.updatedAt)
          record.syncPendingSince = Number.isFinite(updatedAt) ? updatedAt : now
          if (record.kind === 'event' && (record.type as string) === 'Login: Office') {
            record.type = 'Logout: Home'
          }
        })
      })
  }
}

const database = new WorkLogDatabase()

export function newId(): string {
  return crypto.randomUUID()
}

export async function getRecords(): Promise<LogRecord[]> {
  const records = await database.records.toArray()
  const migrationTime = new Date().toISOString()
  const pendingSince = Date.now()
  const migrated: LogRecord[] = records.map((record): LogRecord => {
    const updated = migrateLegacyEvent(record) as LogRecord
    return updated === record
      ? record
      : { ...updated, updatedAt: migrationTime, syncStatus: 'pending' as const, syncPendingSince: pendingSince }
  })
  const changed = migrated.filter((record, index) => record !== records[index])
  if (changed.length) await database.records.bulkPut(changed)
  return migrated
}

function migrateLegacyEvent(record: unknown): unknown {
  if (
    record &&
    typeof record === 'object' &&
    (record as { kind?: unknown }).kind === 'event' &&
    (record as { type?: string }).type === 'Login: Office'
  ) {
    return { ...record, type: 'Logout: Home' }
  }
  return record
}

export async function saveRecord(record: LogRecord): Promise<void> {
  await database.records.put({
    ...record,
    updatedAt: new Date().toISOString(),
    syncStatus: 'pending',
    syncPendingSince: Date.now(),
  })
}

export async function softDeleteRecord(record: LogRecord): Promise<void> {
  await saveRecord({ ...record, deleted: true })
}

export async function makeBackup(): Promise<string> {
  const records = await getRecords()
  return JSON.stringify({ format: 'personal-work-log', version: 2, records }, null, 2)
}

export function isLogRecord(value: unknown): value is LogRecord {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<LogRecord>
  if (
    typeof item.id !== 'string' ||
    typeof item.createdAt !== 'string' ||
    typeof item.updatedAt !== 'string' ||
    typeof item.deleted !== 'boolean' ||
    (item.syncStatus !== undefined && item.syncStatus !== 'pending' && item.syncStatus !== 'synced') ||
    (item.syncPendingSince !== undefined && (typeof item.syncPendingSince !== 'number' || !Number.isFinite(item.syncPendingSince)))
  ) return false

  if (item.kind === 'entry') {
    const entry = item as Partial<Entry>
    return (
      typeof entry.date === 'string' &&
      typeof entry.startAt === 'string' &&
      (entry.endAt === null || typeof entry.endAt === 'string') &&
      ENTRY_TYPES.includes(entry.type as EntryType) &&
      typeof entry.withWho === 'string' &&
      typeof entry.forWhat === 'string' &&
      (entry.startedAtExact === undefined || (typeof entry.startedAtExact === 'number' && Number.isFinite(entry.startedAtExact))) &&
      (entry.endedAtExact === undefined || (typeof entry.endedAtExact === 'number' && Number.isFinite(entry.endedAtExact)))
    )
  }

  if (item.kind === 'event') {
    const event = item as Partial<LogEvent>
    return (
      typeof event.occurredAt === 'string' &&
      EVENT_TYPES.includes(event.type as EventType)
    )
  }
  return false
}

export async function restoreBackup(contents: string): Promise<number> {
  const backup: unknown = JSON.parse(contents)
  if (
    !backup ||
    typeof backup !== 'object' ||
    (backup as { format?: unknown }).format !== 'personal-work-log' ||
    ![undefined, 1, 2].includes((backup as { version?: number }).version) ||
    !Array.isArray((backup as { records?: unknown }).records)
  ) {
    throw new Error('This file is not a valid Work log backup.')
  }

  const migratedRecords = (backup as { records: unknown[] }).records.map(migrateLegacyEvent)
  if (!migratedRecords.every(isLogRecord)) {
    throw new Error('This file is not a valid Work log backup.')
  }
  const pendingSince = Date.now()
  const incoming = (migratedRecords as LogRecord[]).map((record) => ({
    ...record,
    syncStatus: 'pending' as const,
    syncPendingSince: pendingSince,
  }))
  const existingIds = new Set(await database.records.toCollection().primaryKeys())
  const newRecords = incoming.filter((record) => {
    if (existingIds.has(record.id)) return false
    existingIds.add(record.id)
    return true
  })
  if (newRecords.length) await database.records.bulkAdd(newRecords)
  return newRecords.length
}

export async function getPendingRecords(limit = 100): Promise<LogRecord[]> {
  return database.records.where('syncStatus').equals('pending').limit(limit).toArray()
}

export async function getPendingSummary(): Promise<{ count: number; oldestPendingSince?: number }> {
  const records = await database.records.where('syncStatus').equals('pending').toArray()
  const oldestPendingSince = records.reduce<number | undefined>((oldest, record) => {
    const pendingSince = record.syncPendingSince
    return typeof pendingSince === 'number' && (oldest === undefined || pendingSince < oldest)
      ? pendingSince
      : oldest
  }, undefined)
  return {
    count: records.length,
    oldestPendingSince,
  }
}

export async function markRecordsSynced(
  submitted: Array<{ id: string; updatedAt: string }>,
): Promise<void> {
  await database.transaction('rw', database.records, async () => {
    for (const item of submitted) {
      const current = await database.records.get(item.id)
      if (current?.syncStatus !== 'pending' || current.updatedAt !== item.updatedAt) continue
      await database.records.put({ ...current, syncStatus: 'synced', syncPendingSince: undefined })
    }
  })
}

export async function mergePulledRecords(incoming: LogRecord[]): Promise<void> {
  await database.transaction('rw', database.records, async () => {
    for (const remote of incoming) {
      const local = await database.records.get(remote.id)
      if (local?.syncStatus === 'pending') continue
      if (local?.kind === 'entry' && local.endAt === null) continue
      if (local && Date.parse(local.updatedAt) >= Date.parse(remote.updatedAt)) {
        if (Date.parse(local.updatedAt) > Date.parse(remote.updatedAt)) {
          await database.records.put({
            ...local,
            syncStatus: 'pending',
            syncPendingSince: Date.now(),
          })
        }
        continue
      }
      await database.records.put({ ...remote, syncStatus: 'synced', syncPendingSince: undefined })
    }
  })
}

export async function getSyncCursor(): Promise<string> {
  return (await database.syncMeta.get('serverUpdatedAt'))?.value ?? '0'
}

export async function setSyncCursor(cursor: string): Promise<void> {
  await database.syncMeta.put({ key: 'serverUpdatedAt', value: cursor })
}
