import { beforeEach, describe, expect, it } from 'vitest'
import {
  addImportedNames,
  getLocalNames,
  getNamesFromEntries,
  rememberName,
  removeSavedName,
} from './names'

const saved = new Map<string, string>()

beforeEach(() => {
  saved.clear()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => saved.set(key, value),
    },
  })
})

describe('saved name list', () => {
  it('stores trimmed names and rejects empty, comma-containing, and duplicate names', () => {
    expect(rememberName('  Alice  ')).toBe('Alice')
    expect(getLocalNames()).toEqual(['Alice'])
    expect(() => rememberName('')).toThrow('Enter a name.')
    expect(() => rememberName('Bob, Jr')).toThrow('Names cannot contain commas.')
    expect(() => rememberName('aLiCe')).toThrow('already in the list')
  })

  it('keeps saved names explicit and removes a name without changing entry data', () => {
    rememberName('Alice')
    removeSavedName('alice')
    expect(getLocalNames()).toEqual([])
    expect(getNamesFromEntries([{
      id: 'legacy',
      kind: 'entry',
      date: '2026-11-24',
      startAt: '2026-11-24T03:00:00.000Z',
      endAt: '2026-11-24T03:10:00.000Z',
      type: 'Meeting',
      withWho: 'Alice, Bob',
      forWhat: '',
      createdAt: '2026-11-24T03:00:00.000Z',
      updatedAt: '2026-11-24T03:10:00.000Z',
      deleted: false,
    }])).toEqual(['Alice', 'Bob'])
  })

  it('imports only explicitly supplied names and merges without case-insensitive duplicates', () => {
    rememberName('Alice')
    expect(addImportedNames(['Bob', ' bob ', 'ALICE'])).toEqual(['Bob'])
    expect(getLocalNames()).toEqual(['Alice', 'Bob'])
  })
})
