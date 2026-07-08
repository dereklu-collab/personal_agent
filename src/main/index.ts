import { app, BrowserWindow, ipcMain, screen, shell } from 'electron'
import { join } from 'node:path'
import type { AssistantResult, BridgeEvent, Message, PublicSettings } from '@shared/types'
import * as db from './db'
import { resolveApp, allowlistLabels, openApp, closeApp } from './appOpener'
import { hasBrowserSiteIntent, openKnownSite } from './browserControl'
import {
  runAssistant,
  summarizeWritingProfile,
  transcribeAudio,
  AssistantError
} from './assistant'
import { startScheduler, stopScheduler, executeAction } from './scheduler'

let win: BrowserWindow | null = null
let expanded = false

const COLLAPSED = { width: 168, height: 64 }
const EXPANDED = { width: 384, height: 588 }
const MARGIN = 16

function positionFor(size: { width: number; height: number }): {
  x: number
  y: number
} {
  const { workArea } = screen.getPrimaryDisplay()
  return {
    x: workArea.x + workArea.width - size.width - MARGIN,
    y: workArea.y + workArea.height - size.height - MARGIN
  }
}

function applyBounds(): void {
  if (!win) return
  const size = expanded ? EXPANDED : COLLAPSED
  const { x, y } = positionFor(size)
  win.setBounds({ x, y, width: size.width, height: size.height }, false)
}

function createWindow(): void {
  const size = COLLAPSED
  const { x, y } = positionFor(size)
  win = new BrowserWindow({
    width: size.width,
    height: size.height,
    x,
    y,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: false,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  win.setAlwaysOnTop(true, 'floating')
  win.once('ready-to-show', () => win?.show())

  // Open external links in the OS browser, never in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function toPublicSettings(): PublicSettings {
  const s = db.getRawSettings()
  return {
    provider: s.provider,
    model: s.model,
    hasApiKey: !!s.apiKey,
    hasTranscribeKey: !!s.transcribeKey,
    autoApproveActions: s.autoApproveActions,
    onboarded: s.onboarded
  }
}

function emit(event: BridgeEvent): void {
  win?.webContents.send('bridge:event', event)
}

function formatEmailDraft(email: {
  to?: string
  subject?: string
  body: string
}): string {
  const parts = ['Draft email:']
  if (email.to) parts.push(`To: ${email.to}`)
  if (email.subject) parts.push(`Subject: ${email.subject}`)
  parts.push('', email.body.trim())
  return parts.join('\n')
}

function hasImmediateOpenIntent(text: string): boolean {
  const lower = text.toLowerCase()
  const asksToOpen = /\b(open|launch|start)\b/.test(lower)
  const isScheduled =
    /\b(in\s+\d+|at\s+\d+|tomorrow|tonight|later|next\s+\w+|on\s+\w+day|schedule|remind)\b/.test(
      lower
    )
  return asksToOpen && !isScheduled
}

function parseRelativeDate(text: string): string | null {
  const relative = text.match(
    /\bin\s+(\d+)\s*(second|seconds|sec|secs|minute|minutes|min|hour|hours|hr|hrs|day|days)\b/i
  )
  if (!relative) return null
  const amount = Number(relative[1])
  const unit = relative[2].toLowerCase()
  const date = new Date()
  if (unit.startsWith('sec')) date.setSeconds(date.getSeconds() + amount)
  else if (unit.startsWith('min')) date.setMinutes(date.getMinutes() + amount)
  else if (unit.startsWith('hour') || unit === 'hr' || unit === 'hrs') {
    date.setHours(date.getHours() + amount)
  } else if (unit.startsWith('day')) date.setDate(date.getDate() + amount)
  return date.toISOString()
}

function assistantFailureMessage(): string {
  return (
    'This request cannot be fulfilled. Autonomy cannot complete this action yet. ' +
    'Please try rephrasing the request or use a supported command.'
  )
}

function parseDateFromTaskText(text: string): string | null {
  const relative = parseRelativeDate(text)
  if (relative) return relative

  const numeric = text.match(
    /\b(?:on\s+)?(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?/i
  )
  if (numeric) {
    const month = Number(numeric[1])
    const day = Number(numeric[2])
    const rawYear = Number(numeric[3])
    const year = rawYear < 100 ? 2000 + rawYear : rawYear
    let hour = numeric[4] ? Number(numeric[4]) : 9
    const minute = numeric[5] ? Number(numeric[5]) : 0
    const meridiem = numeric[6]?.toLowerCase()
    if (meridiem === 'pm' && hour < 12) hour += 12
    if (meridiem === 'am' && hour === 12) hour = 0
    const date = new Date(year, month - 1, day, hour, minute)
    return Number.isNaN(date.getTime()) ? null : date.toISOString()
  }

  const tomorrow = text.match(
    /\btomorrow(?:\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?/i
  )
  if (tomorrow) {
    const date = new Date()
    date.setDate(date.getDate() + 1)
    let hour = tomorrow[1] ? Number(tomorrow[1]) : 9
    const minute = tomorrow[2] ? Number(tomorrow[2]) : 0
    const meridiem = tomorrow[3]?.toLowerCase()
    if (meridiem === 'pm' && hour < 12) hour += 12
    if (meridiem === 'am' && hour === 12) hour = 0
    date.setHours(hour, minute, 0, 0)
    return date.toISOString()
  }

  return null
}

function cleanTaskTitle(text: string): string {
  let title = text
    .replace(/^\s*(hi|hey|hello)[,!]?\s+/i, '')
    .replace(/\bin\s+\d+\s*(minute|minutes|min|hour|hours|hr|hrs|day|days)\b/gi, '')
    .replace(/\b(?:on\s+)?\d{1,2}\/\d{1,2}\/\d{2,4}(?:\s+(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?/gi, '')
    .replace(/\btomorrow(?:\s+(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?/gi, '')
    .replace(/^(please\s+)?(create|add|make)\s+(a\s+)?(new\s+)?(task|todo|to-do)\s*/i, '')
    .replace(/^(please\s+)?(create|add|make)\s+(a\s+)?(new\s+)?(task|todo|to-do)\s+(to|for|called|named)\s*/i, '')
    .replace(/^(please\s+)?schedule\s+(a\s+)?/i, '')
    .replace(/\s+(as|like)\s+(a\s+)?(task|todo|to-do)\b/gi, '')
    .replace(/\s+(for me|for myself)\b/gi, '')
    .replace(/\b(task|todo|to-do)\s+(for|to)\b/gi, '')
    .replace(/^(to|for|called|named)\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim()

  title = title.replace(/\bfor\s+([A-Z][a-z]+)$/i, 'with $1')

  const meetingWith = title.match(/\bmeeting\b(?:\s+with)?\s+(.+)$/i)
  if (meetingWith) title = `Meeting with ${meetingWith[1].trim()}`

  return title
}

function isTaskRequest(text: string): boolean {
  const lower = text.toLowerCase()
  if (/\b(open|launch|start)\b/.test(lower) && resolveApp(text)) return false
  return (
    /\b(create|add|make)\s+(a\s+)?(new\s+)?(task|todo|to-do)\b/.test(lower) ||
    /\bschedule\b/.test(lower)
  )
}

function tryCreateTaskNow(text: string, userMessage: Message): AssistantResult | null {
  if (!isTaskRequest(text)) return null
  const title = cleanTaskTitle(text)
  if (!title || /^(it|this|that)(\s+as\s+(a\s+)?task)?$/i.test(title)) return null

  const due = parseDateFromTaskText(text)
  db.addTask(title, due)
  const dueText = due ? ` It is due ${new Date(due).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })}.` : ''
  const assistantMessage = db.addMessage(
    'assistant',
    `Created task: ${title}.${dueText}`,
    'create_task'
  )
  return {
    userMessage,
    assistantMessage,
    intent: 'create_task'
  }
}

function tryOpenAppNow(text: string, userMessage: Message): AssistantResult | null {
  if (!hasImmediateOpenIntent(text)) return null

  const label = resolveApp(text)
  if (!label) {
    const message =
      'This request cannot be fulfilled. Autonomy can currently open only these apps: ' +
      `${allowlistLabels().join(', ')}.`
    const assistantMessage = db.addMessage('assistant', message, 'schedule_app_open')
    return {
      userMessage,
      assistantMessage,
      intent: 'schedule_app_open'
    }
  }

  const result = openApp(label)
  const message = result.ok
    ? `Opening ${result.label} now.`
    : `This request cannot be fulfilled. Autonomy could not open ${label}. ${result.reason}`
  const assistantMessage = db.addMessage('assistant', message, 'schedule_app_open')
  if (!result.ok) db.addLog('system', `Immediate app open failed: ${label}: ${result.reason}`)
  return {
    userMessage,
    assistantMessage,
    intent: 'schedule_app_open'
  }
}

function tryCloseAppNow(text: string, userMessage: Message): AssistantResult | null {
  const lower = text.toLowerCase()
  if (!/\b(close|quit|exit|shut)\b/.test(lower)) return null

  const label = resolveApp(text)
  if (!label) {
    const message =
      'This request cannot be fulfilled. Autonomy can currently close only these apps: ' +
      `${allowlistLabels().join(', ')}.`
    const assistantMessage = db.addMessage('assistant', message, 'schedule_app_open')
    return {
      userMessage,
      assistantMessage,
      intent: 'schedule_app_open'
    }
  }

  const result = closeApp(label)
  const message = result.ok
    ? `Closing ${result.label}.`
    : `This request cannot be fulfilled. Autonomy could not close ${label}. ${result.reason}`
  const assistantMessage = db.addMessage('assistant', message, 'schedule_app_open')
  if (!result.ok) db.addLog('system', `Immediate app close failed: ${label}: ${result.reason}`)
  return {
    userMessage,
    assistantMessage,
    intent: 'schedule_app_open'
  }
}

function tryBrowserSiteOpen(text: string, userMessage: Message): AssistantResult | null {
  if (!hasBrowserSiteIntent(text)) return null

  const result = openKnownSite(text)
  const message = result.ok
    ? `Opening ${result.site} in ${result.browser}.`
    : `This request cannot be fulfilled. ${result.reason}`
  const assistantMessage = db.addMessage('assistant', message, 'schedule_app_open')
  if (!result.ok) db.addLog('system', `Browser action failed: ${result.reason}`)
  return {
    userMessage,
    assistantMessage,
    intent: 'schedule_app_open'
  }
}

function tryScheduleAppOpen(text: string, userMessage: Message): AssistantResult | null {
  const lower = text.toLowerCase()
  if (!/\b(open|launch|start)\b/.test(lower)) return null

  const datetime = parseRelativeDate(text)
  if (!datetime) return null

  const label = resolveApp(text)
  if (!label) {
    const message =
      'This request cannot be fulfilled. Autonomy can currently schedule only these apps: ' +
      `${allowlistLabels().join(', ')}.`
    const assistantMessage = db.addMessage('assistant', message, 'schedule_app_open')
    return { userMessage, assistantMessage, intent: 'schedule_app_open' }
  }

  db.addScheduledAction(label, datetime, 'approved', `Requested from chat: ${text}`)
  const when = new Date(datetime).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit'
  })
  const assistantMessage = db.addMessage(
    'assistant',
    `Scheduled ${label} to open at ${when}.`,
    'schedule_app_open'
  )
  return { userMessage, assistantMessage, intent: 'schedule_app_open' }
}

// ---------------------------------------------------------------------------
// IPC: every renderer request is validated here before touching state.
// ---------------------------------------------------------------------------
function registerIpc(): void {
  ipcMain.handle('window:setExpanded', (_e, value: unknown) => {
    expanded = value === true
    applyBounds()
    return expanded
  })

  ipcMain.handle('settings:get', () => toPublicSettings())

  ipcMain.handle('settings:set', (_e, patch: unknown) => {
    const p = (patch ?? {}) as Record<string, unknown>
    const clean: Parameters<typeof db.setSettings>[0] = {}
    if (p.provider === 'anthropic' || p.provider === 'openai' || p.provider === 'ollama')
      clean.provider = p.provider
    if (typeof p.model === 'string' && p.model.trim()) clean.model = p.model.trim()
    if (typeof p.apiKey === 'string') clean.apiKey = p.apiKey
    if (typeof p.transcribeKey === 'string') clean.transcribeKey = p.transcribeKey
    if (typeof p.autoApproveActions === 'boolean')
      clean.autoApproveActions = p.autoApproveActions
    if (typeof p.onboarded === 'boolean') clean.onboarded = p.onboarded
    db.setSettings(clean)
    return toPublicSettings()
  })

  ipcMain.handle('settings:reset', () => {
    db.resetSettings()
    return toPublicSettings()
  })

  ipcMain.handle('apps:allowlist', () => allowlistLabels())

  ipcMain.handle('messages:list', () => db.listMessages())
  ipcMain.handle('messages:clear', () => {
    db.clearMessages()
    return true
  })

  ipcMain.handle('tasks:list', () => db.listTasks())
  ipcMain.handle('tasks:toggle', (_e, id: unknown) =>
    typeof id === 'number' ? db.toggleTask(id) : null
  )
  ipcMain.handle('tasks:updateDue', (_e, id: unknown, due: unknown) => {
    if (typeof id !== 'number') return null
    if (due !== null && typeof due !== 'string') return null
    if (typeof due === 'string' && Number.isNaN(Date.parse(due))) return null
    return db.updateTaskDue(id, due)
  })
  ipcMain.handle('tasks:delete', (_e, id: unknown) => {
    if (typeof id === 'number') db.deleteTask(id)
    return true
  })

  ipcMain.handle('reminders:list', () => db.listReminders())
  ipcMain.handle('reminders:dismiss', (_e, id: unknown) => {
    if (typeof id === 'number') db.dismissReminder(id)
    return true
  })

  ipcMain.handle('actions:list', () => db.listScheduledActions())
  ipcMain.handle('actions:approve', (_e, id: unknown) => {
    if (typeof id !== 'number') return null
    // Run immediately if it's already due; otherwise mark approved for later.
    const a = db.getAction(id)
    if (!a) return null
    if (new Date(a.datetime).getTime() <= Date.now() || a.status === 'awaiting_confirm') {
      executeAction(id, emit)
    } else {
      db.setActionStatus(id, 'approved')
    }
    emit({ type: 'data-changed' })
    return db.getAction(id)
  })
  ipcMain.handle('actions:cancel', (_e, id: unknown) => {
    if (typeof id === 'number') db.setActionStatus(id, 'cancelled')
    return true
  })

  ipcMain.handle('logs:list', () => db.listLogs())

  // ---- writing style ----
  ipcMain.handle('writing:addSample', (_e, content: unknown) => {
    if (typeof content !== 'string' || !content.trim()) return null
    return db.addWritingSample(content.trim())
  })
  ipcMain.handle('writing:listSamples', () => db.listWritingSamples())
  ipcMain.handle('writing:deleteSample', (_e, id: unknown) => {
    if (typeof id === 'number') db.deleteWritingSample(id)
    return true
  })
  ipcMain.handle('writing:getProfile', () => db.getWritingProfile())
  ipcMain.handle('writing:buildProfile', async () => {
    const samples = db.listWritingSamples().map((s) => s.content)
    if (samples.length === 0) {
      throw new AssistantError('Add at least one writing sample first.')
    }
    const summary = await summarizeWritingProfile(samples)
    return db.setWritingProfile(summary)
  })

  // ---- the core assistant turn ----
  ipcMain.handle('assistant:send', async (_e, text: unknown) => {
    if (typeof text !== 'string' || !text.trim()) {
      throw new AssistantError('Empty message.')
    }
    const userMessage = db.addMessage('user', text.trim(), null)
    emit({ type: 'data-changed' })

    const scheduledOpenResult = tryScheduleAppOpen(text.trim(), userMessage)
    if (scheduledOpenResult) {
      emit({ type: 'data-changed' })
      return scheduledOpenResult
    }

    const closeAppResult = tryCloseAppNow(text.trim(), userMessage)
    if (closeAppResult) {
      emit({ type: 'data-changed' })
      return closeAppResult
    }

    const browserSiteResult = tryBrowserSiteOpen(text.trim(), userMessage)
    if (browserSiteResult) {
      emit({ type: 'data-changed' })
      return browserSiteResult
    }

    const immediateOpenResult = tryOpenAppNow(text.trim(), userMessage)
    if (immediateOpenResult) {
      emit({ type: 'data-changed' })
      return immediateOpenResult
    }

    const immediateTaskResult = tryCreateTaskNow(text.trim(), userMessage)
    if (immediateTaskResult) {
      emit({ type: 'data-changed' })
      return immediateTaskResult
    }

    let res: Awaited<ReturnType<typeof runAssistant>>
    try {
      res = await runAssistant(text.trim())
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'Unknown assistant error'
      db.addLog('system', `Assistant request failed: ${detail}`)
      const message = assistantFailureMessage()
      const assistantMessage = db.addMessage('assistant', message, 'general_chat')
      emit({ type: 'data-changed' })
      return {
        userMessage,
        assistantMessage,
        intent: 'general_chat'
      }
    }

    // Persist any structured side effects the model asked for.
    const s = db.getRawSettings()
    for (const t of res.tasks) db.addTask(t.title, t.due ?? null)
    for (const r of res.reminders)
      db.addReminder(r.title, r.datetime, r.recurrence)

    const rejected: string[] = []
    for (const sa of res.scheduledActions) {
      const label = resolveApp(sa.app)
      if (!label) {
        rejected.push(sa.app)
        db.addLog('system', `Blocked scheduled app (not allowlisted): ${sa.app}`)
        continue
      }
      db.addScheduledAction(
        label,
        sa.datetime,
        s.autoApproveActions ? 'approved' : 'pending',
        sa.note ?? null
      )
    }

    let responseText = res.response
    if (res.intent === 'generate_email' && res.email) {
      responseText = `${res.response.trim()}\n\n${formatEmailDraft(res.email)}`
    }
    if (rejected.length) {
      responseText += `\n\n(Note: I can't schedule ${rejected.join(
        ', '
      )} — only these apps are allowed: ${allowlistLabels().join(', ')}.)`
    }

    const assistantMessage = db.addMessage('assistant', responseText, res.intent)
    emit({ type: 'data-changed' })

    return {
      userMessage,
      assistantMessage,
      intent: res.intent,
      email: res.email
    }
  })

  // ---- transcription ----
  ipcMain.handle(
    'assistant:transcribe',
    async (_e, payload: unknown) => {
      const p = payload as { bytes?: ArrayBuffer; mimeType?: string }
      if (!p?.bytes || !(p.bytes instanceof ArrayBuffer)) {
        throw new AssistantError('No audio received.')
      }
      return transcribeAudio(p.bytes, p.mimeType || 'audio/webm')
    }
  )
}

app.whenReady().then(() => {
  db.initDb()
  db.clearMessages()
  registerIpc()
  createWindow()
  startScheduler(() => win)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  stopScheduler()
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => stopScheduler())
