import type { Reminder, ScheduledAction, Task } from '@shared/types'

interface Props {
  tasks: Task[]
  reminders: Reminder[]
  actions: ScheduledAction[]
  onToggleTask: (id: number) => void
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

export function TaskList({
  tasks,
  reminders,
  actions,
  onToggleTask,
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
          <p className="section-title">Scheduled apps</p>
          {actions.map((a) => (
            <div key={a.id} className="card">
              <div className="grow">
                <div className="primary">Open {a.app}</div>
                <div className="meta">{when(a.datetime)}</div>
              </div>
              <span className={`status-chip ${a.status}`}>
                {a.status.replace(/_/g, ' ')}
              </span>
              {(a.status === 'awaiting_confirm' || a.status === 'pending') && (
                <button
                  className="mini primary"
                  onClick={() => onApproveAction(a.id)}
                >
                  {a.status === 'awaiting_confirm' ? 'Open now' : 'Approve'}
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
