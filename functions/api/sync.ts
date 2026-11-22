import type { PagesFunction } from '@cloudflare/workers-types'
import { asDatabaseValues, jsonResponse, readJsonBody, validateRecord, type Environment } from './_shared'

const UPSERT_SQL = `
  INSERT INTO entries (
    id, kind, date, startAt, endAt, type, withWho, forWhat,
    startedAtExact, endedAtExact, occurredAt, createdAt, updatedAt,
    deleted, createdAtExact, serverUpdatedAt
  ) VALUES (
    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
    MAX(?, COALESCE((SELECT MAX(serverUpdatedAt) + 1 FROM entries), ?))
  )
  ON CONFLICT(id) DO UPDATE SET
    kind = excluded.kind,
    date = excluded.date,
    startAt = excluded.startAt,
    endAt = excluded.endAt,
    type = excluded.type,
    withWho = excluded.withWho,
    forWhat = excluded.forWhat,
    startedAtExact = excluded.startedAtExact,
    endedAtExact = excluded.endedAtExact,
    occurredAt = excluded.occurredAt,
    createdAt = excluded.createdAt,
    updatedAt = excluded.updatedAt,
    deleted = excluded.deleted,
    createdAtExact = excluded.createdAtExact,
    serverUpdatedAt = MAX(
      excluded.serverUpdatedAt,
      COALESCE((SELECT MAX(serverUpdatedAt) + 1 FROM entries), excluded.serverUpdatedAt)
    )
  WHERE excluded.updatedAt > entries.updatedAt
`

export const onRequestPost: PagesFunction<Environment> = async ({ request, env }) => {
  let body: unknown
  try {
    body = await readJsonBody(request)
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : 'Invalid request body.' }, 400)
  }

  if (
    !body ||
    typeof body !== 'object' ||
    !Array.isArray((body as { entries?: unknown }).entries) ||
    Object.keys(body).some((key) => key !== 'entries')
  ) {
    return jsonResponse({ error: 'Body must contain an entries array.' }, 400)
  }
  const submitted = (body as { entries: unknown[] }).entries
  if (submitted.length < 1 || submitted.length > 100) {
    return jsonResponse({ error: 'Batch size must be between 1 and 100.' }, 400)
  }
  const entries = submitted.map(validateRecord)
  if (entries.some((entry) => entry === null)) {
    return jsonResponse({ error: 'One or more records are invalid.' }, 400)
  }
  const records = entries as NonNullable<(typeof entries)[number]>[]
  if (new Set(records.map((record) => record.id)).size !== records.length) {
    return jsonResponse({ error: 'Batch contains duplicate ids.' }, 400)
  }

  try {
    const now = Date.now()
    const statements = records.map((record) =>
      env.DB.prepare(UPSERT_SQL).bind(...asDatabaseValues(record), now, now),
    )
    await env.DB.batch(statements)
    return jsonResponse({ acceptedIds: records.map((record) => record.id) })
  } catch {
    return jsonResponse({ error: 'Could not save the sync batch.' }, 500)
  }
}
