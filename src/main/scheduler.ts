import { Notification } from 'electron'
import type { BrowserWindow } from 'electron'
import type { BridgeEvent, Recurrence } from '@shared/types'
import * as db from './db'
import { openApp } from './appOpener'
import { decodeBrowserActionNote, runBrowserSiteAction } from './browserControl'

const TICK_MS = 1_000
let timer: NodeJS.Timeout | null = null

function nextOccurrence(iso: string, recurrence: Recurrence): string | null {
  if (recurrence === 'none') return null
  const d = new Date(iso)
  if (recurrence === 'daily') d.setDate(d.getDate() + 1)
  else if (recurrence === 'weekly') d.setDate(d.getDate() + 7)
  else if (recurrence === 'monthly') d.setMonth(d.getMonth() + 1)
  return d.toISOString()
}

export function startScheduler(getWindow: () => BrowserWindow | null): void {
  const emit = (event: BridgeEvent): void => {
    getWindow()?.webContents.send('bridge:event', event)
  }

  const tick = (): void => {
    const now = new Date().toISOString()

    // ---- reminders ----
    for (const r of db.dueReminders(now)) {
      if (Notification.isSupported()) {
        new Notification({ title: 'Reminder', body: r.title }).show()
      }
      const next = nextOccurrence(r.datetime, r.recurrence)
      if (next) db.rescheduleReminder(r.id, next)
      else db.markReminderFired(r.id)
      db.addLog('reminder', `Reminder fired: ${r.title}`)
      emit({ type: 'reminder-due', reminder: r })
    }

    // ---- scheduled actions ----
    const settings = db.getRawSettings()
    for (const a of db.dueScheduledActions(now)) {
      const preApproved = a.status === 'approved' || settings.autoApproveActions
      if (!preApproved) {
        // Needs explicit confirmation: flag it and surface in the UI.
        const updated = db.setActionStatus(a.id, 'awaiting_confirm')
        if (Notification.isSupported()) {
          const browserAction = decodeBrowserActionNote(a.note)
          new Notification({
            title: 'Action ready',
            body: browserAction
              ? `${browserAction.kind === 'open' ? 'Open' : 'Close'} ${browserAction.site}? Confirm in the widget.`
              : `Open ${a.app}? Confirm in the widget.`
          }).show()
        }
        if (updated) emit({ type: 'action-awaiting-confirm', action: updated })
        continue
      }
      executeAction(a.id, emit)
    }

    emit({ type: 'data-changed' })
  }

  timer = setInterval(tick, TICK_MS)
  tick()
}

/** Run an action now (used by the scheduler and by explicit user approval). */
export function executeAction(
  id: number,
  emit: (event: BridgeEvent) => void
): void {
  const action = db.getAction(id)
  if (!action) return
  const browserAction = decodeBrowserActionNote(action.note)
  if (browserAction) {
    const result = runBrowserSiteAction(browserAction)
    if (result.ok) {
      const updated = db.setActionStatus(id, 'done')
      const verb = browserAction.kind === 'open' ? 'Opened' : 'Closed'
      const log = db.addLog(
        'scheduled_action',
        `${verb} ${result.site} in ${result.browser}`
      )
      if (updated) emit({ type: 'action-executed', action: updated })
      emit({ type: 'log', log })
    } else {
      db.setActionStatus(id, 'error')
      const verb = browserAction.kind === 'open' ? 'open' : 'close'
      const message = `I couldn't ${verb} ${browserAction.site} in ${browserAction.browser}: ${result.reason}`
      db.addMessage('assistant', message, 'schedule_app_open')
      const log = db.addLog('scheduled_action', message)
      emit({ type: 'log', log })
      emit({ type: 'data-changed' })
    }
    return
  }

  const result = openApp(action.app)
  if (result.ok) {
    const updated = db.setActionStatus(id, 'done')
    const log = db.addLog('scheduled_action', `Opened ${result.label}`)
    if (updated) emit({ type: 'action-executed', action: updated })
    emit({ type: 'log', log })
  } else {
    db.setActionStatus(id, 'error')
    const message = `I couldn't open ${action.app}: ${result.reason}`
    db.addMessage('assistant', message, 'schedule_app_open')
    const log = db.addLog('scheduled_action', message)
    emit({ type: 'log', log })
    emit({ type: 'data-changed' })
  }
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer)
  timer = null
}
