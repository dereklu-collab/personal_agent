import { app, BrowserWindow, ipcMain, screen, shell } from 'electron'
import { join } from 'node:path'
import type { BridgeEvent, PublicSettings } from '@shared/types'
import * as db from './db'
import { resolveApp, allowlistLabels } from './appOpener'
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
<<<<<<< HEAD
    if (p.provider === 'anthropic' || p.provider === 'openai')
=======
    if (p.provider === 'anthropic' || p.provider === 'openai' || p.provider === 'ollama')
>>>>>>> aae2071 (Added Ollama)
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
    const res = await runAssistant(text.trim())

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
