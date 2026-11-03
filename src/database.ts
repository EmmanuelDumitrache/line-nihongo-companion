import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.js";

/* ------------------------------------------------------------------ */
/* Types                                                              */
/* ------------------------------------------------------------------ */

export type ChatRole = "user" | "model";
export type ConversationKind = "user" | "group" | "room";

export interface UserProfile {
  userId: string;
  displayName: string | null;
  mode: string;
  jlptLevel: string;
  nativeLang: string;
  isFriend: boolean;
  createdAt: number;
  lastSeen: number;
}

export interface Conversation {
  convoId: string;
  kind: ConversationKind;
  summary: string | null;
  summaryThroughId: number;
  createdAt: number;
  updatedAt: number;
}

export interface StoredMessage {
  id: number;
  convoId: string;
  role: ChatRole;
  content: string;
  createdAt: number;
}

export interface Reminder {
  id: number;
  userId: string;
  targetId: string;
  targetKind: ConversationKind;
  text: string;
  dueAt: number;
  attempts: number;
  sentAt: number | null;
  createdAt: number;
}

interface UserRow {
  user_id: string;
  display_name: string | null;
  mode: string;
  jlpt_level: string;
  native_lang: string;
  is_friend: number;
  created_at: number;
  last_seen: number;
}

interface ConversationRow {
  convo_id: string;
  kind: ConversationKind;
  summary: string | null;
  summary_through_id: number;
  created_at: number;
  updated_at: number;
}

interface MessageRow {
  id: number;
  convo_id: string;
  role: ChatRole;
  content: string;
  created_at: number;
}

interface ReminderRow {
  id: number;
  user_id: string;
  target_id: string;
  target_kind: ConversationKind;
  text: string;
  due_at: number;
  attempts: number;
  sent_at: number | null;
  created_at: number;
}

/* ------------------------------------------------------------------ */
/* Connection                                                         */
/* ------------------------------------------------------------------ */

let db: Database.Database | null = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  user_id       TEXT PRIMARY KEY,
  display_name  TEXT,
  mode          TEXT NOT NULL DEFAULT 'auto',
  jlpt_level    TEXT NOT NULL DEFAULT 'n5',
  native_lang   TEXT NOT NULL DEFAULT 'en',
  is_friend     INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL,
  last_seen     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  convo_id            TEXT PRIMARY KEY,
  kind                TEXT NOT NULL,
  summary             TEXT,
  summary_through_id  INTEGER NOT NULL DEFAULT 0,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  convo_id    TEXT NOT NULL,
  role        TEXT NOT NULL,
  content     TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_convo ON messages (convo_id, id DESC);

CREATE TABLE IF NOT EXISTS reminders (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL,
  target_id   TEXT NOT NULL,
  target_kind TEXT NOT NULL DEFAULT 'user',
  text        TEXT NOT NULL,
  due_at      INTEGER NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  sent_at     INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders (sent_at, due_at);

CREATE TABLE IF NOT EXISTS webhook_events (
  event_id    TEXT PRIMARY KEY,
  received_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_webhook_events_received ON webhook_events (received_at);
`;

function conn(): Database.Database {
  if (!db) throw new Error("Database not initialised. Call initDatabase() first.");
  return db;
}

export function initDatabase(path: string = config.dbPath): Database.Database {
  if (db) return db;

  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }

  const database = new Database(path);
  // WAL is ignored (returns "memory") for in-memory databases — harmless.
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  database.exec(SCHEMA);
  db = database;

  pruneWebhookEvents(Date.now() - 7 * 24 * 60 * 60 * 1000);
  return database;
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}

/* ------------------------------------------------------------------ */
/* Users                                                              */
/* ------------------------------------------------------------------ */

function mapUser(row: UserRow): UserProfile {
  return {
    userId: row.user_id,
    displayName: row.display_name,
    mode: row.mode,
    jlptLevel: row.jlpt_level,
    nativeLang: row.native_lang,
    isFriend: row.is_friend === 1,
    createdAt: row.created_at,
    lastSeen: row.last_seen,
  };
}

export function upsertUser(userId: string, displayName?: string | null): UserProfile {
  const now = Date.now();
  conn()
    .prepare(
      `INSERT INTO users (user_id, display_name, created_at, last_seen)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         last_seen = excluded.last_seen,
         display_name = COALESCE(excluded.display_name, users.display_name),
         is_friend = 1`
    )
    .run(userId, displayName ?? null, now, now);

  const user = getUser(userId);
  if (!user) throw new Error(`Failed to load user ${userId} after upsert`);
  return user;
}

export function getUser(userId: string): UserProfile | null {
  const row = conn().prepare("SELECT * FROM users WHERE user_id = ?").get(userId) as
    | UserRow
    | undefined;
  return row ? mapUser(row) : null;
}

export interface UserPatch {
  mode?: string;
  jlptLevel?: string;
  nativeLang?: string;
  displayName?: string | null;
  isFriend?: boolean;
}

const USER_FIELD_MAP: Record<keyof UserPatch, string> = {
  mode: "mode",
  jlptLevel: "jlpt_level",
  nativeLang: "native_lang",
  displayName: "display_name",
  isFriend: "is_friend",
};

/** Column names come from a fixed map, never from user input. */
export function updateUser(userId: string, patch: UserPatch): void {
  const entries = Object.entries(patch) as Array<[keyof UserPatch, string | boolean | null]>;
  if (entries.length === 0) return;

  const sets: string[] = [];
  const values: Array<string | number | null> = [];

  for (const [key, value] of entries) {
    sets.push(`${USER_FIELD_MAP[key]} = ?`);
    values.push(typeof value === "boolean" ? (value ? 1 : 0) : value);
  }

  values.push(userId);
  conn()
    .prepare(`UPDATE users SET ${sets.join(", ")} WHERE user_id = ?`)
    .run(...values);
}

export function markUserUnfollowed(userId: string): void {
  conn().prepare("UPDATE users SET is_friend = 0 WHERE user_id = ?").run(userId);
}

/* ------------------------------------------------------------------ */
/* Conversations                                                      */
/* ------------------------------------------------------------------ */

function mapConversation(row: ConversationRow): Conversation {
  return {
    convoId: row.convo_id,
    kind: row.kind,
    summary: row.summary,
    summaryThroughId: row.summary_through_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getOrCreateConversation(
  convoId: string,
  kind: ConversationKind
): Conversation {
  const now = Date.now();
  conn()
    .prepare(
      `INSERT INTO conversations (convo_id, kind, created_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(convo_id) DO UPDATE SET updated_at = excluded.updated_at`
    )
    .run(convoId, kind, now, now);

  const row = conn()
    .prepare("SELECT * FROM conversations WHERE convo_id = ?")
    .get(convoId) as ConversationRow | undefined;

  if (!row) throw new Error(`Failed to load conversation ${convoId}`);
  return mapConversation(row);
}

function mapMessage(row: MessageRow): StoredMessage {
  return {
    id: row.id,
    convoId: row.convo_id,
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
  };
}

export function appendMessage(convoId: string, role: ChatRole, content: string): number {
  const now = Date.now();
  const info = conn()
    .prepare("INSERT INTO messages (convo_id, role, content, created_at) VALUES (?, ?, ?, ?)")
    .run(convoId, role, content, now);
  conn()
    .prepare("UPDATE conversations SET updated_at = ? WHERE convo_id = ?")
    .run(now, convoId);
  return Number(info.lastInsertRowid);
}

/**
 * Returns messages in chronological order. `afterId` keeps already-summarised
 * turns out of the prompt so long conversations do not double-count them.
 */
export function getRecentMessages(convoId: string, limit: number, afterId = 0): StoredMessage[] {
  const rows = conn()
    .prepare(
      `SELECT * FROM messages
       WHERE convo_id = ? AND id > ?
       ORDER BY id DESC
       LIMIT ?`
    )
    .all(convoId, afterId, limit) as MessageRow[];

  return rows.reverse().map(mapMessage);
}

export function countMessagesAfter(convoId: string, afterId: number): number {
  const row = conn()
    .prepare("SELECT COUNT(*) AS n FROM messages WHERE convo_id = ? AND id > ?")
    .get(convoId, afterId) as { n: number };
  return row.n;
}

export function countMessages(convoId: string): number {
  const row = conn()
    .prepare("SELECT COUNT(*) AS n FROM messages WHERE convo_id = ?")
    .get(convoId) as { n: number };
  return row.n;
}

export function setSummary(convoId: string, summary: string, throughId: number): void {
  conn()
    .prepare(
      `UPDATE conversations
       SET summary = ?, summary_through_id = ?, updated_at = ?
       WHERE convo_id = ?`
    )
    .run(summary.slice(0, config.memory.summaryMaxChars), throughId, Date.now(), convoId);
}

export function clearConversation(convoId: string): void {
  const transaction = conn().transaction(() => {
    conn().prepare("DELETE FROM messages WHERE convo_id = ?").run(convoId);
    conn()
      .prepare(
        `UPDATE conversations
         SET summary = NULL, summary_through_id = 0, updated_at = ?
         WHERE convo_id = ?`
      )
      .run(Date.now(), convoId);
  });
  transaction();
}

/* ------------------------------------------------------------------ */
/* Reminders                                                          */
/* ------------------------------------------------------------------ */

function mapReminder(row: ReminderRow): Reminder {
  return {
    id: row.id,
    userId: row.user_id,
    targetId: row.target_id,
    targetKind: row.target_kind,
    text: row.text,
    dueAt: row.due_at,
    attempts: row.attempts,
    sentAt: row.sent_at,
    createdAt: row.created_at,
  };
}

export function addReminder(input: {
  userId: string;
  targetId: string;
  targetKind: ConversationKind;
  text: string;
  dueAt: number;
}): Reminder {
  const info = conn()
    .prepare(
      `INSERT INTO reminders (user_id, target_id, target_kind, text, due_at, attempts, created_at)
       VALUES (?, ?, ?, ?, ?, 0, ?)`
    )
    .run(
      input.userId,
      input.targetId,
      input.targetKind,
      input.text,
      input.dueAt,
      Date.now()
    );

  const row = conn()
    .prepare("SELECT * FROM reminders WHERE id = ?")
    .get(Number(info.lastInsertRowid)) as ReminderRow | undefined;

  if (!row) throw new Error("Failed to load reminder after insert");
  return mapReminder(row);
}

export function dueReminders(now: number, limit = 20): Reminder[] {
  const rows = conn()
    .prepare(
      `SELECT * FROM reminders
       WHERE sent_at IS NULL AND due_at <= ?
       ORDER BY due_at ASC
       LIMIT ?`
    )
    .all(now, limit) as ReminderRow[];
  return rows.map(mapReminder);
}

export function markReminderSent(id: number): void {
  conn().prepare("UPDATE reminders SET sent_at = ? WHERE id = ?").run(Date.now(), id);
}

export function bumpReminderAttempt(id: number): number {
  conn().prepare("UPDATE reminders SET attempts = attempts + 1 WHERE id = ?").run(id);
  const row = conn().prepare("SELECT attempts FROM reminders WHERE id = ?").get(id) as
    | { attempts: number }
    | undefined;
  return row?.attempts ?? 0;
}

export function listPendingReminders(userId: string, limit = 10): Reminder[] {
  const rows = conn()
    .prepare(
      `SELECT * FROM reminders
       WHERE user_id = ? AND sent_at IS NULL
       ORDER BY due_at ASC
       LIMIT ?`
    )
    .all(userId, limit) as ReminderRow[];
  return rows.map(mapReminder);
}

/** Scoped by user so one person cannot delete another person's reminder by id. */
export function deleteReminder(id: number, userId: string): boolean {
  const info = conn()
    .prepare("DELETE FROM reminders WHERE id = ? AND user_id = ? AND sent_at IS NULL")
    .run(id, userId);
  return info.changes > 0;
}

/* ------------------------------------------------------------------ */
/* Webhook de-duplication                                             */
/* ------------------------------------------------------------------ */

/**
 * LINE retries webhook deliveries when it does not receive a prompt 2xx.
 * Returns true the first time an event id is seen, false for retries.
 */
export function registerWebhookEvent(eventId: string): boolean {
  const info = conn()
    .prepare("INSERT OR IGNORE INTO webhook_events (event_id, received_at) VALUES (?, ?)")
    .run(eventId, Date.now());
  return info.changes > 0;
}

export function pruneWebhookEvents(before: number): number {
  const info = conn().prepare("DELETE FROM webhook_events WHERE received_at < ?").run(before);
  return info.changes;
}

/** Called from the reminder loop once a day; keeps the dedupe table bounded. */
export function pruneOldData(now = Date.now()): void {
  pruneWebhookEvents(now - 7 * 24 * 60 * 60 * 1000);
  // Reminders older than 30 days that were delivered are no longer useful.
  conn()
    .prepare("DELETE FROM reminders WHERE sent_at IS NOT NULL AND sent_at < ?")
    .run(now - 30 * 24 * 60 * 60 * 1000);
}
