import type { LogRecord } from './model'

const CUSTOM_NAMES_KEY = 'personal-work-log-names'

export function splitNames(value: string): string[] {
  return value.split(',').map((name) => name.trim()).filter(Boolean)
}

export function getLocalNames(): string[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(CUSTOM_NAMES_KEY) ?? '[]')
    if (!Array.isArray(saved)) return []
    const names: string[] = []
    for (const rawName of saved) {
      if (typeof rawName !== 'string') continue
      const name = rawName.trim()
      if (!name || name.includes(',')) continue
      if (!names.some((existing) => existing.toLocaleLowerCase() === name.toLocaleLowerCase())) {
        names.push(name)
      }
    }
    return names
  } catch {
    return []
  }
}

export function saveLocalNames(names: string[]): void {
  const normalized: string[] = []
  for (const rawName of names) {
    const name = rawName.trim()
    if (!name || name.includes(',')) throw new Error('Names must be non-empty and cannot contain commas.')
    if (!normalized.some((saved) => saved.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      normalized.push(name)
    }
  }
  localStorage.setItem(CUSTOM_NAMES_KEY, JSON.stringify(normalized))
}

export function rememberName(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('Enter a name.')
  if (trimmed.includes(',')) throw new Error('Names cannot contain commas.')
  const names = getLocalNames()
  if (names.some((existing) => existing.toLocaleLowerCase() === trimmed.toLocaleLowerCase())) {
    throw new Error('That name is already in the list.')
  }
  saveLocalNames([...names, trimmed])
  return trimmed
}

export function removeSavedName(name: string): void {
  const key = name.toLocaleLowerCase()
  saveLocalNames(getLocalNames().filter((saved) => saved.toLocaleLowerCase() !== key))
}

export function addImportedNames(namesToAdd: string[]): string[] {
  const existing = getLocalNames()
  const known = new Set(existing.map((name) => name.toLocaleLowerCase()))
  const added = namesToAdd.map((name) => name.trim()).filter((name) => {
    if (!name || name.includes(',')) return false
    const key = name.toLocaleLowerCase()
    if (known.has(key)) return false
    known.add(key)
    return true
  })
  saveLocalNames([...existing, ...added])
  return added
}

export function getNamesFromEntries(records: LogRecord[]): string[] {
  const names = new Map<string, string>()
  for (const record of records) {
    if (record.kind !== 'entry' || record.deleted) continue
    for (const name of splitNames(record.withWho ?? '')) {
      const key = name.toLocaleLowerCase()
      if (!names.has(key)) names.set(key, name)
    }
  }
  return [...names.values()].sort((left, right) => left.localeCompare(right))
}
