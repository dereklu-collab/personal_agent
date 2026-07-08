import type { Reminder, ScheduledAction, Task } from '@shared/types'

interface Props {
  tasks: Task[]
  reminders: Reminder[]
  actions: ScheduledAction[]
  onToggleTask: (id: number) => void
  onUpdateTaskDue: (id: number, due: string | null) => void
  onDeleteTask: (id: number) => void
  onDismissReminder: (id: number) => void
  onApproveAction: (id: number) => void
  onCancelAction: (id: number) => void
}

function when(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  if (sameDay) return `Today ${time}`
  const tomorrow = new Date(now)
  tomorrow.setDate(now.getDate() + 1)
  if (d.toDateString() === tomorrow.toDateString()) return `Tomorrow ${time}`
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ` ${time}`
}

function toDateTimeInput(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`
}

function fromDateTimeInput(value: string): string | null {
  if (!value) return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

function actionStatusText(action: ScheduledAction): string {
  if (action.status === 'pending') return 'Needs approval'
  if (action.status === 'approved') return browserAction(action) ? 'Will auto-run' : 'Will auto-open'
  if (action.status === 'awaiting_confirm') return 'Ready now'
  return action.status.replace(/_/g, ' ')
}

function browserAction(action: ScheduledAction): {
  kind: 'open' | 'close'
  site: string
  browser: string
} | null {
  if (!action.note?.startsWith('browser-action:')) return null
  try {
    const value = JSON.parse(action.note.slice('browser-action:'.length)) as {
      kind?: unknown
      site?: unknown
      browser?: unknown
    }
    if (
      (value.kind === 'open' || value.kind === 'close') &&
      typeof value.site === 'string' &&
      typeof value.browser === 'string'
    ) {
      return { kind: value.kind, site: value.site, browser: value.browser }
    }
  } catch {
    return null
  }
  return null
}

function actionTitle(action: ScheduledAction): string {
  const browser = browserAction(action)
  if (!browser) return `Open ${action.app}`
  const verb = browser.kind === 'open' ? 'Open' : 'Close'
  return `${verb} ${browser.site} in ${browser.browser}`
}

function actionNote(action: ScheduledAction): string | null {
  return browserAction(action) ? null : action.note
}

export function TaskList({
  tasks,
  reminders,
  actions,
  onToggleTask,
  onUpdateTaskDue,
  onDeleteTask,
  onDismissReminder,
  onApproveAction,
  onCancelAction
}: Props) {
  const empty =
    tasks.length === 0 && reminders.length === 0 && actions.length === 0

  if (empty) {
    return (
      <div className="empty">
        <div className="big">✧</div>
        <div className="line">Nothing scheduled yet.</div>
        <div className="line" style={{ fontSize: 11 }}>
          Tasks, reminders, and app launches show up here.
        </div>
      </div>
    )
  }

  return (
    <div className="scroll">
      {tasks.length > 0 && (
        <div>
          <p className="section-title">Tasks</p>
          {tasks.map((t) => (
            <div key={t.id} className={`card ${t.done ? 'done' : ''}`}>
              <button
                className={`check ${t.done ? 'on' : ''}`}
                onClick={() => onToggleTask(t.id)}
                aria-label={t.done ? 'Mark not done' : 'Mark done'}
              >
                ✓
              </button>
              <div className="grow">
                <div className="primary">{t.title}</div>
                {t.due && <div className="meta">Due {when(t.due)}</div>}
                <div className="due-editor">
                  <label htmlFor={`task-due-${t.id}`}>Due</label>
                  <input
                    id={`task-due-${t.id}`}
                    type="datetime-local"
                    value={toDateTimeInput(t.due)}
                    onChange={(e) =>
                      onUpdateTaskDue(t.id, fromDateTimeInput(e.target.value))
                    }
                  />
                  {t.due && (
                    <button className="mini" onClick={() => onUpdateTaskDue(t.id, null)}>
                      Clear
                    </button>
                  )}
                </div>
              </div>
              <button className="mini danger" onClick={() => onDeleteTask(t.id)}>
                Remove
              </button>
            </div>
          ))}
        </div>
      )}

      {reminders.length > 0 && (
        <div>
          <p className="section-title">Reminders</p>
          {reminders.map((r) => (
            <div key={r.id} className="card">
              <div className="grow">
                <div className="primary">{r.title}</div>
                <div className="meta">
                  {when(r.datetime)}
                  {r.recurrence !== 'none' && ` · ${r.recurrence}`}
                  {r.fired && ' · done'}
                </div>
              </div>
              <button className="mini" onClick={() => onDismissReminder(r.id)}>
                Dismiss
              </button>
            </div>
          ))}
        </div>
      )}

      {actions.length > 0 && (
        <div>
          <p className="section-title">Scheduled actions</p>
          {actions.map((a) => (
            <div key={a.id} className="card action-card">
              <div className="grow">
                <div className="primary">{actionTitle(a)}</div>
                <div className="meta">
                  {when(a.datetime)}
                  {actionNote(a) && ` · ${actionNote(a)}`}
                </div>
              </div>
              <span className={`status-chip ${a.status}`}>
                {actionStatusText(a)}
              </span>
              {(a.status === 'awaiting_confirm' || a.status === 'pending') && (
                <button
                  className="mini primary"
                  onClick={() => onApproveAction(a.id)}
                >
                  {a.status === 'awaiting_confirm' ? 'Open now' : 'Auto-open'}
                </button>
              )}
              {a.status !== 'done' && (
                <button className="mini danger" onClick={() => onCancelAction(a.id)}>
                  Cancel
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
