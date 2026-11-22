CREATE TABLE IF NOT EXISTS entries (
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
  CHECK (
    (
      kind = 'entry'
      AND type IN ('Work', 'Meeting', 'Break', 'Washroom', 'Lunch')
      AND date IS NOT NULL
      AND startAt IS NOT NULL
      AND withWho IS NOT NULL
      AND forWhat IS NOT NULL
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

CREATE INDEX IF NOT EXISTS entries_serverUpdatedAt_idx
  ON entries (serverUpdatedAt);
