DROP VIEW entries_readable;

CREATE TABLE entries_v3 (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('entry', 'event')),
  date TEXT,
  startAt TEXT,
  endAt TEXT,
  type TEXT NOT NULL,
  withWho TEXT,
  forWhat TEXT,
  startedAtExact INTEGER,
  endedAtExact INTEGER,
  occurredAt TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  deleted INTEGER NOT NULL CHECK (deleted IN (0, 1)),
  serverUpdatedAt INTEGER NOT NULL,
  createdAtExact INTEGER,
  CHECK (
    (
      kind = 'entry'
      AND type IN (
        'Work', 'Meeting', 'Doubts/Queries', 'Replies',
        'Break', 'Washroom', 'Lunch'
      )
      AND date IS NOT NULL
      AND startAt IS NOT NULL
    )
    OR (
      kind = 'event'
      AND type IN (
        'Clock in', 'Clock out', 'Login: Home', 'Logout: Home',
        'System restart', 'Connection lost', 'Reconnected'
      )
      AND occurredAt IS NOT NULL
    )
  )
);

INSERT INTO entries_v3 (
  id, kind, date, startAt, endAt, type, withWho, forWhat,
  startedAtExact, endedAtExact, occurredAt, createdAt, updatedAt,
  deleted, serverUpdatedAt, createdAtExact
)
SELECT
  id, kind, date, startAt, endAt, type, withWho, forWhat,
  startedAtExact, endedAtExact, occurredAt, createdAt, updatedAt,
  deleted, serverUpdatedAt, createdAtExact
FROM entries;

DROP TABLE entries;
ALTER TABLE entries_v3 RENAME TO entries;

CREATE INDEX entries_serverUpdatedAt_idx
  ON entries (serverUpdatedAt);

CREATE INDEX entries_createdAtExact_idx
  ON entries (createdAtExact);

CREATE VIEW entries_readable AS
SELECT
  id,
  type,
  withWho,
  forWhat,
  strftime('%Y-%m-%d %H:%M', datetime(COALESCE(startAt, occurredAt), '+330 minutes')) AS start,
  strftime('%Y-%m-%d %H:%M', datetime(endAt, '+330 minutes')) AS end,
  CASE
    WHEN kind = 'entry' AND endAt IS NOT NULL THEN
      CAST(strftime('%s', endAt) / 60 AS INTEGER)
      - CAST(strftime('%s', startAt) / 60 AS INTEGER)
  END AS durationMinutes,
  CASE
    WHEN startedAtExact IS NOT NULL AND endedAtExact IS NOT NULL THEN
      ROUND((endedAtExact - startedAtExact) / 1000.0, 3)
  END AS exactSeconds,
  CASE WHEN deleted = 1 THEN 'Yes' ELSE 'No' END AS deleted,
  strftime(
    '%Y-%m-%d %H:%M',
    datetime(
      COALESCE(
        createdAtExact,
        CAST(strftime('%s', updatedAt) AS INTEGER) * 1000
          + CAST(substr(updatedAt, 21, 3) AS INTEGER)
      ) / 1000,
      'unixepoch',
      '+330 minutes'
    )
  ) AS createdAtExact
FROM entries
ORDER BY
  COALESCE(
    createdAtExact,
    CAST(strftime('%s', updatedAt) AS INTEGER) * 1000
      + CAST(substr(updatedAt, 21, 3) AS INTEGER)
  ) DESC,
  id DESC;
