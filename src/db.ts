import Dexie, { type EntityTable } from 'dexie'

export const ENTRY_TYPES = ['Work', 'Meeting', 'Break', 'Washroom', 'Lunch'] as const
export const EVENT_TYPES = [
  'Clock in',
  'Clock out',
  'Login: Home',
  'Logout: Home',
  'System restart',
  'Connection lost',
  'Reconnected',
] as const

export type EntryType = (typeof ENTRY_TYPES)[number]
export type EventType = (typeof EVENT_TYPES)[number]

interface BaseRecord {
  id: string
  createdAt: string
  updatedAt: string
  deleted: boolean
}

export interface Entry extends BaseRecord {
  kind: 'entry'
  date: string
  startAt: string
  endAt: string | null
  type: EntryType
  withWho: string
  forWhat: string
}

export interface LogEvent extends BaseRecord {
  kind: 'event'
  occurredAt: string
  type: EventType
}

export type LogRecord = Entry | LogEvent

class WorkLogDatabase extends Dexie {
  records!: EntityTable<LogRecord, 'id'>

  constructor() {
    super('personal-work-log')
    this.version(1).stores({ records: 'id, kind, date, startAt, occurredAt, deleted' })
  }
}

const database = new WorkLogDatabase()

export function newId(): string {
  return crypto.randomUUID()
}

export async function getRecords(): Promise<LogRecord[]> {
  const records = await database.records.toArray()
  const migrated = records.map(migrateLegacyEvent)
  const changed = migrated.filter((record, index) => record !== records[index])
  if (changed.length) await database.records.bulkPut(changed)
  return migrated
}

function migrateLegacyEvent(record: LogRecord): LogRecord {
  if (record.kind === 'event' && (record.type as string) === 'Login: Office') {
    return { ...record, type: 'Logout: Home' }
  }
  return record
}

export async function saveRecord(record: LogRecord): Promise<void> {
  await database.records.put(record)
}

export async function softDeleteRecord(record: LogRecord): Promise<void> {
  await database.records.put({ ...record, deleted: true, updatedAt: new Date().toISOString() })
}

export async function makeBackup(): Promise<string> {
  const records = await getRecords()
  return JSON.stringify({ format: 'personal-work-log', version: 1, records }, null, 2)
}

function isRecord(value: unknown): value is LogRecord {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<LogRecord>
  if (
    typeof item.id !== 'string' ||
    typeof item.createdAt !== 'string' ||
    typeof item.updatedAt !== 'string' ||
    typeof item.deleted !== 'boolean'
  ) return false

  if (item.kind === 'entry') {
    const entry = item as Partial<Entry>
    return (
      typeof entry.date === 'string' &&
      typeof entry.startAt === 'string' &&
      (entry.endAt === null || typeof entry.endAt === 'string') &&
      ENTRY_TYPES.includes(entry.type as EntryType) &&
      typeof entry.withWho === 'string' &&
      typeof entry.forWhat === 'string'
    )
  }

  if (item.kind === 'event') {
    const event = item as Partial<LogEvent>
    return (
      typeof event.occurredAt === 'string' &&
      (EVENT_TYPES.includes(event.type as EventType) || (event.type as string) === 'Login: Office')
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
    (backup as { version?: unknown }).version !== 1 ||
    !Array.isArray((backup as { records?: unknown }).records) ||
    !(backup as { records: unknown[] }).records.every(isRecord)
  ) {
    throw new Error('This file is not a valid Work log backup.')
  }

  const incoming = (backup as { records: LogRecord[] }).records.map(migrateLegacyEvent)
  const existingIds = new Set(await database.records.toCollection().primaryKeys())
  const newRecords = incoming.filter((record) => {
    if (existingIds.has(record.id)) return false
    existingIds.add(record.id)
    return true
  })
  if (newRecords.length) await database.records.bulkAdd(newRecords)
  return newRecords.length
}
