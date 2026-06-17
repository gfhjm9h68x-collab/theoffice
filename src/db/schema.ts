/**
 * SQLite schema for The Office. Carries forward the proven data model from the
 * old `claudeclaw.db` (memories with tiers + FTS5, kanban, inter-agent messages,
 * daily logs, token usage) and adds the v2 durable queues. WAL mode is set at
 * open time in db/index.ts.
 *
 * Design note: the legacy empty `scheduled_tasks` table is intentionally dropped —
 * file-based scheduled tasks (tenant/scheduled-tasks/) are the source of truth.
 *
 * ⚠️ FROZEN AT THE v1 BASELINE (Model A). Do NOT add columns/tables here for new schema changes — this is
 * exactly the schema `user_version` 1 represents. ALL post-v1 changes go ONLY in MIGRATIONS (src/db/migrate.ts):
 * a fresh install runs SCHEMA_SQL(v1) then the migrations, so a change made in BOTH would double-apply and
 * crash the fresh install on a duplicate column. Frozen baseline + migrations-only keeps fresh == existing.
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS memories (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id     TEXT NOT NULL,
  category     TEXT NOT NULL CHECK (category IN ('hot','warm','cold','shared')),
  content      TEXT NOT NULL,
  keywords     TEXT,
  sector       TEXT,
  salience     REAL NOT NULL DEFAULT 1.0,
  embedding    TEXT,
  auto_generated INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  accessed_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_memories_agent ON memories(agent_id);
CREATE INDEX IF NOT EXISTS idx_memories_agent_cat ON memories(agent_id, category);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content, keywords, content='memories', content_rowid='id'
);
-- keep FTS in sync with the base table
CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content, keywords) VALUES (new.id, new.content, new.keywords);
END;
CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, keywords) VALUES('delete', old.id, old.content, old.keywords);
END;
CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, keywords) VALUES('delete', old.id, old.content, old.keywords);
  INSERT INTO memories_fts(rowid, content, keywords) VALUES (new.id, new.content, new.keywords);
END;

-- card ids are TEXT (preserved from v1 so comments + parent links stay intact)
CREATE TABLE IF NOT EXISTS kanban_cards (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  description TEXT,
  status      TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','in_progress','waiting','done')),
  assignee    TEXT,
  priority    TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  project     TEXT,
  parent_id   TEXT REFERENCES kanban_cards(id),
  due_date    INTEGER,
  sort_order  REAL NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  archived_at INTEGER,
  dispatched_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_kanban_status ON kanban_cards(status, archived_at);
CREATE INDEX IF NOT EXISTS idx_kanban_parent ON kanban_cards(parent_id);

CREATE TABLE IF NOT EXISTS kanban_comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id    TEXT NOT NULL,
  author     TEXT,
  content    TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_kanban_comments_card ON kanban_comments(card_id);

CREATE TABLE IF NOT EXISTS agent_messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  from_agent   TEXT NOT NULL,
  to_agent     TEXT NOT NULL,
  content      TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivered','done','failed')),
  result       TEXT,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  delivered_at INTEGER,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_agent_messages_status ON agent_messages(status);

CREATE TABLE IF NOT EXISTS daily_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id   TEXT NOT NULL,
  date       TEXT NOT NULL,
  content    TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_daily_logs_agent ON daily_logs(agent_id);

CREATE TABLE IF NOT EXISTS conversation_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id   TEXT NOT NULL,
  channel_id TEXT,
  direction  TEXT NOT NULL CHECK (direction IN ('in','out')),
  message_id TEXT,
  text       TEXT,
  ts         TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (agent_id, channel_id, direction, message_id)
);

CREATE TABLE IF NOT EXISTS token_usage (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  agent                TEXT NOT NULL,
  session_id           TEXT,
  timestamp            INTEGER NOT NULL,
  input_tokens         INTEGER NOT NULL DEFAULT 0,
  output_tokens        INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens    INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  content_preview      TEXT,
  tool_name            TEXT,
  task_title           TEXT,
  project              TEXT
);
CREATE INDEX IF NOT EXISTS idx_token_usage_agent_ts ON token_usage(agent, timestamp);

-- v2 durable inbound queue: the SINGLE entry point for everything that becomes
-- a prompt to an agent (channel msgs, scheduled tasks, inter-agent). One queue,
-- one deliverer — no second writer to a tmux pane.
CREATE TABLE IF NOT EXISTS inbound_queue (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id    TEXT NOT NULL,
  source      TEXT NOT NULL CHECK (source IN ('channel','scheduler','bus','manual')),
  prompt      TEXT NOT NULL,
  -- channel-reply context (so the agent knows where to answer)
  reply_channel TEXT,
  reply_user    TEXT,
  -- idempotency: a source can set a dedup key to avoid double-enqueue
  dedup_key   TEXT,
  status      TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','delivering','delivered','failed')),
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  delivered_at INTEGER,
  UNIQUE (agent_id, dedup_key)
);
CREATE INDEX IF NOT EXISTS idx_inbound_status ON inbound_queue(status, agent_id);

-- v2 durable outbound queue: agent -> Slack (Web API). Retriable, logged.
CREATE TABLE IF NOT EXISTS outbound_queue (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id   TEXT NOT NULL,
  channel    TEXT NOT NULL,
  text       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','failed')),
  attempts   INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  sent_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_outbound_status ON outbound_queue(status);

-- record of scheduled-task fires (dedup within a cron minute + history)
CREATE TABLE IF NOT EXISTS task_runs (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  name  TEXT NOT NULL,
  agent TEXT NOT NULL,
  ts    INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_task_runs_ts ON task_runs(ts);
`;
