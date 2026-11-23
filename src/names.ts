import type { LogRecord } from './model'

const CUSTOM_NAMES_KEY = 'personal-work-log-names'

export function splitNames(value: string): string[] {
  return value.split(',').map((name) => name.trim()).filter(Boolean)
}

export function getLocalNames(): string[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(CUSTOM_NAMES_KEY) ?? '[]')
    return Array.isArray(saved)
      ? saved.filter((name): name is string => typeof name === 'string').map((name) => name.trim()).filter(Boolean)
      : []
  } catch {
    return []
  }
}

export function getNameOptions(records: LogRecord[], localNames: string[]): string[] {
  const counts = new Map<string, { name: string; count: number }>()
  for (const record of records) {
    if (record.kind !== 'entry') continue
    for (const name of splitNames(record.withWho ?? '')) {
      const key = name.toLocaleLowerCase()
      const current = counts.get(key)
      counts.set(key, { name: current?.name ?? name, count: (current?.count ?? 0) + 1 })
    }
  }
  for (const name of localNames) {
    const key = name.toLocaleLowerCase()
    if (!counts.has(key)) counts.set(key, { name, count: 0 })
  }
  return [...counts.values()]
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name))
    .map(({ name }) => name)
}

export function rememberName(name: string, names: string[]): string {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('Enter a name.')
  if (trimmed.includes(',')) throw new Error('Names cannot contain commas.')
  if (names.some((existing) => existing.toLocaleLowerCase() === trimmed.toLocaleLowerCase())) {
    throw new Error('That name is already in the list.')
  }
  const next = [...getLocalNames(), trimmed]
  localStorage.setItem(CUSTOM_NAMES_KEY, JSON.stringify(next))
  return trimmed
}
