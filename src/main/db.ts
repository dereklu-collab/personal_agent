import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'node:path'
import type {
  ActionLog,
  Intent,
  Message,
  Provider,
  Recurrence,
  Reminder,
  ScheduledAction,
  ScheduledActionStatus,
  Task,
  WritingProfile,
  WritingSample
} from '@shared/types'

let db: Database.Database

export function initDb(): void {
  const file = join(app.getPath('userData'), 'pa.db')
  db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      intent TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      done INTEGER NOT NULL DEFAULT 0,
      due TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      datetime TEXT NOT NULL,
      recurrence TEXT NOT NULL DEFAULT 'none',
      fired INTEGER NOT NULL DEFAULT 0,
      dismissed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS scheduled_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      app TEXT NOT NULL,
      datetime TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS writing_samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS writing_profile (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      summary TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS action_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)
}

// ---------- helpers ----------
const nowIso = (): string => new Date().toISOString()

// ---------- settings (key/value) ----------
// Raw settings live here, including secrets. Only the main process reads them.
export interface RawSettings {
  provider: Provider
  model: string
  apiKey: string
  transcribeKey: string
  autoApproveActions: boolean
  onboarded: boolean
}

const SETTINGS_DEFAULTS: RawSettings = {
  provider: 'anthropic',
  model: 'claude-3-5-sonnet-latest',
  apiKey: '',
  transcribeKey: '',
  autoApproveActions: false,
  onboarded: false
}

export function getRawSettings(): RawSettings {
  const rows = db.prepare('SELECT key, value FROM settings').all() as {
    key: string
    value: string
  }[]
  const map = new Map(rows.map((r) => [r.key, r.value]))
  return {
    provider: (map.get('provider') as Provider) ?? SETTINGS_DEFAULTS.provider,
    model: map.get('model') ?? SETTINGS_DEFAULTS.model,
    apiKey: map.get('apiKey') ?? '',
    transcribeKey: map.get('transcribeKey') ?? '',
    autoApproveActions: map.get('autoApproveActions') === '1',
    onboarded: map.get('onboarded') === '1'
  }
}

export function setSettings(patch: Partial<RawSettings>): void {
  const stmt = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  )
  const tx = db.transaction((entries: [string, string][]) => {
    for (const [k, v] of entries) stmt.run(k, v)
  })
  const entries: [string, string][] = []
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue
    if (typeof v === 'boolean') entries.push([k, v ? '1' : '0'])
    else entries.push([k, String(v)])
  }
  if (entries.length) tx(entries)
}

export function resetSettings(): void {
  db.prepare('DELETE FROM settings').run()
}

// ---------- messages ----------
function rowToMessage(r: any): Message {
  return {
    id: r.id,
    role: r.role,
    content: r.content,
    intent: (r.intent as Intent) ?? null,
    createdAt: r.created_at
  }
}

export function addMessage(
  role: 'user' | 'assistant',
  content: string,
  intent: Intent | null
): Message {
  const info = db
    .prepare(
      'INSERT INTO messages (role, content, intent, created_at) VALUES (?, ?, ?, ?)'
    )
    .run(role, content, intent, nowIso())
  return rowToMessage(
    db.prepare('SELECT * FROM messages WHERE id = ?').get(info.lastInsertRowid)
  )
}

export function listMessages(limit = 100): Message[] {
  const rows = db
    .prepare('SELECT * FROM messages ORDER BY id DESC LIMIT ?')
    .all(limit) as any[]
  return rows.reverse().map(rowToMessage)
}

export function clearMessages(): void {
  db.prepare('DELETE FROM messages').run()
}

// ---------- tasks ----------
function rowToTask(r: any): Task {
  return {
    id: r.id,
    title: r.title,
    done: !!r.done,
    due: r.due ?? null,
    createdAt: r.created_at
  }
}

export function addTask(title: string, due: string | null): Task {
  const info = db
    .prepare('INSERT INTO tasks (title, due, created_at) VALUES (?, ?, ?)')
    .run(title, due, nowIso())
  return rowToTask(
    db.prepare('SELECT * FROM tasks WHERE id = ?').get(info.lastInsertRowid)
  )
}

export function listTasks(): Task[] {
  const rows = db
    .prepare('SELECT * FROM tasks ORDER BY done ASC, id DESC')
    .all() as any[]
  return rows.map(rowToTask)
}

export function toggleTask(id: number): Task | null {
  db.prepare('UPDATE tasks SET done = 1 - done WHERE id = ?').run(id)
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id)
  return row ? rowToTask(row) : null
}

export function deleteTask(id: number): void {
  db.prepare('DELETE FROM tasks WHERE id = ?').run(id)
}

// ---------- reminders ----------
function rowToReminder(r: any): Reminder {
  return {
    id: r.id,
    title: r.title,
    datetime: r.datetime,
    recurrence: r.recurrence as Recurrence,
    fired: !!r.fired,
    dismissed: !!r.dismissed,
    createdAt: r.created_at
  }
}

export function addReminder(
  title: string,
  datetime: string,
  recurrence: Recurrence
): Reminder {
  const info = db
    .prepare(
      'INSERT INTO reminders (title, datetime, recurrence, created_at) VALUES (?, ?, ?, ?)'
    )
    .run(title, datetime, recurrence, nowIso())
  return rowToReminder(
    db.prepare('SELECT * FROM reminders WHERE id = ?').get(info.lastInsertRowid)
  )
}

export function listReminders(): Reminder[] {
  const rows = db
    .prepare(
      'SELECT * FROM reminders WHERE dismissed = 0 ORDER BY datetime ASC'
    )
    .all() as any[]
  return rows.map(rowToReminder)
}

export function dueReminders(nowIsoStr: string): Reminder[] {
  const rows = db
    .prepare(
      'SELECT * FROM reminders WHERE fired = 0 AND dismissed = 0 AND datetime <= ?'
    )
    .all(nowIsoStr) as any[]
  return rows.map(rowToReminder)
}

export function markReminderFired(id: number): void {
  db.prepare('UPDATE reminders SET fired = 1 WHERE id = ?').run(id)
}

export function rescheduleReminder(id: number, nextIso: string): void {
  db.prepare('UPDATE reminders SET datetime = ?, fired = 0 WHERE id = ?').run(
    nextIso,
    id
  )
}

export function dismissReminder(id: number): void {
  db.prepare('UPDATE reminders SET dismissed = 1 WHERE id = ?').run(id)
}

// ---------- scheduled actions ----------
function rowToAction(r: any): ScheduledAction {
  return {
    id: r.id,
    app: r.app,
    datetime: r.datetime,
    status: r.status as ScheduledActionStatus,
    note: r.note ?? null,
    createdAt: r.created_at
  }
}

export function addScheduledAction(
  appName: string,
  datetime: string,
  status: ScheduledActionStatus,
  note: string | null
): ScheduledAction {
  const info = db
    .prepare(
      'INSERT INTO scheduled_actions (app, datetime, status, note, created_at) VALUES (?, ?, ?, ?, ?)'
    )
    .run(appName, datetime, status, note, nowIso())
  return rowToAction(
    db
      .prepare('SELECT * FROM scheduled_actions WHERE id = ?')
      .get(info.lastInsertRowid)
  )
}

export function listScheduledActions(): ScheduledAction[] {
  const rows = db
    .prepare(
      "SELECT * FROM scheduled_actions WHERE status NOT IN ('done','cancelled') ORDER BY datetime ASC"
    )
    .all() as any[]
  return rows.map(rowToAction)
}

export function dueScheduledActions(nowIsoStr: string): ScheduledAction[] {
  const rows = db
    .prepare(
      "SELECT * FROM scheduled_actions WHERE datetime <= ? AND status IN ('pending','approved')"
    )
    .all(nowIsoStr) as any[]
  return rows.map(rowToAction)
}

export function setActionStatus(
  id: number,
  status: ScheduledActionStatus
): ScheduledAction | null {
  db.prepare('UPDATE scheduled_actions SET status = ? WHERE id = ?').run(
    status,
    id
  )
  const row = db.prepare('SELECT * FROM scheduled_actions WHERE id = ?').get(id)
  return row ? rowToAction(row) : null
}

export function getAction(id: number): ScheduledAction | null {
  const row = db.prepare('SELECT * FROM scheduled_actions WHERE id = ?').get(id)
  return row ? rowToAction(row) : null
}

// ---------- writing ----------
function rowToSample(r: any): WritingSample {
  return { id: r.id, content: r.content, createdAt: r.created_at }
}

export function addWritingSample(content: string): WritingSample {
  const info = db
    .prepare('INSERT INTO writing_samples (content, created_at) VALUES (?, ?)')
    .run(content, nowIso())
  return rowToSample(
    db
      .prepare('SELECT * FROM writing_samples WHERE id = ?')
      .get(info.lastInsertRowid)
  )
}

export function listWritingSamples(): WritingSample[] {
  const rows = db
    .prepare('SELECT * FROM writing_samples ORDER BY id DESC')
    .all() as any[]
  return rows.map(rowToSample)
}

export function deleteWritingSample(id: number): void {
  db.prepare('DELETE FROM writing_samples WHERE id = ?').run(id)
}

export function setWritingProfile(summary: string): WritingProfile {
  db.prepare(
    'INSERT INTO writing_profile (id, summary, updated_at) VALUES (1, ?, ?) ' +
      'ON CONFLICT(id) DO UPDATE SET summary = excluded.summary, updated_at = excluded.updated_at'
  ).run(summary, nowIso())
  return getWritingProfile()!
}

export function getWritingProfile(): WritingProfile | null {
  const row = db.prepare('SELECT * FROM writing_profile WHERE id = 1').get() as any
  return row ? { summary: row.summary, updatedAt: row.updated_at } : null
}

// ---------- logs ----------
function rowToLog(r: any): ActionLog {
  return { id: r.id, kind: r.kind, message: r.message, createdAt: r.created_at }
}

export function addLog(kind: ActionLog['kind'], message: string): ActionLog {
  const info = db
    .prepare('INSERT INTO action_logs (kind, message, created_at) VALUES (?, ?, ?)')
    .run(kind, message, nowIso())
  return rowToLog(
    db.prepare('SELECT * FROM action_logs WHERE id = ?').get(info.lastInsertRowid)
  )
}

export function listLogs(limit = 100): ActionLog[] {
  const rows = db
    .prepare('SELECT * FROM action_logs ORDER BY id DESC LIMIT ?')
    .all(limit) as any[]
  return rows.map(rowToLog)
}
