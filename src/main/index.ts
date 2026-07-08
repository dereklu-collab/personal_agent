import { app, BrowserWindow, ipcMain, screen, shell } from 'electron'
import { join } from 'node:path'
import type { AssistantResult, BridgeEvent, Message, PublicSettings } from '@shared/types'
import * as db from './db'
import { resolveApp, allowlistLabels, openApp, closeApp, openSystemUrl } from './appOpener'
import {
  browserSiteActionFromText,
  closeKnownSite,
  encodeBrowserActionNote,
  hasBrowserSiteCloseIntent,
  hasBrowserSiteIntent,
  openKnownSite
} from './browserControl'
import {
  runAssistant,
  summarizeText,
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
  app.setName('AI Assistant')
  const size = COLLAPSED
  const { x, y } = positionFor(size)
  win = new BrowserWindow({
    title: 'AI Assistant',
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
    'This request cannot be fulfilled. AI Assistant cannot complete this action yet. ' +
    'Please try rephrasing the request or use a supported command.'
  )
}

function addBasicAssistantMessage(
  userMessage: Message,
  content: string
): AssistantResult {
  const assistantMessage = db.addMessage('assistant', content, 'general_chat')
  return {
    userMessage,
    assistantMessage,
    intent: 'general_chat'
  }
}

function tryTellTimeNow(text: string, userMessage: Message): AssistantResult | null {
  const lower = text.toLowerCase()
  const isTimeRequest =
    /\b(what'?s|what is|tell me|current|local)\b.*\b(time|date|day)\b/.test(lower) ||
    /\b(time|date) now\b/.test(lower)
  if (!isTimeRequest) return null

  const tz = timeZoneForText(text)
  const now = new Date()
  const formatted = new Intl.DateTimeFormat([], {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: tz.timeZone
  }).format(now)
  const suffix = tz.label ? ` in ${tz.label}` : ''
  return addBasicAssistantMessage(userMessage, `It is ${formatted}${suffix}.`)
}

function timeZoneForText(text: string): { timeZone: string; label: string | null } {
  const lower = text.toLowerCase()
  if (/\b(nyc|new york|brooklyn|manhattan)\b/.test(lower)) {
    return { timeZone: 'America/New_York', label: 'New York' }
  }
  if (/\b(la|los angeles)\b/.test(lower)) {
    return { timeZone: 'America/Los_Angeles', label: 'Los Angeles' }
  }
  if (/\b(chicago)\b/.test(lower)) {
    return { timeZone: 'America/Chicago', label: 'Chicago' }
  }
  if (/\b(london)\b/.test(lower)) {
    return { timeZone: 'Europe/London', label: 'London' }
  }
  return {
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    label: null
  }
}

function isWeatherRequest(text: string): boolean {
  return /\b(weather|temperature|forecast)\b/i.test(text)
}

function extractWeatherLocation(text: string): string | null {
  const cleaned = text
    .replace(/[?.!,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  const explicit = cleaned.match(/\b(?:in|for|at|near)\s+(.+)$/i)
  let location = explicit?.[1]?.trim()

  if (!location) {
    location = cleaned
      .replace(/\b(what'?s|what is|how'?s|how is|tell me|show me|give me|current|today'?s|today|right now|now)\b/gi, ' ')
      .replace(/\b(the|weather|temperature|forecast|like|outside|conditions)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  }

  location = location
    .replace(/\b(today|right now|now|currently|outside)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (!location || /^(here|outside|today|now|right now)$/i.test(location)) return null
  if (/^(nyc|new york city)$/i.test(location)) return 'New York City'
  if (/^(la)$/i.test(location)) return 'Los Angeles'
  return location
}

function weatherDescription(code: number): string {
  if (code === 0) return 'clear'
  if ([1, 2, 3].includes(code)) return 'partly cloudy'
  if ([45, 48].includes(code)) return 'foggy'
  if ([51, 53, 55, 56, 57].includes(code)) return 'drizzly'
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return 'rainy'
  if ([71, 73, 75, 77, 85, 86].includes(code)) return 'snowy'
  if ([95, 96, 99].includes(code)) return 'stormy'
  return 'mixed'
}

async function tryWeatherNow(
  text: string,
  userMessage: Message
): Promise<AssistantResult | null> {
  if (!isWeatherRequest(text)) return null

  const location = extractWeatherLocation(text)
  if (!location) {
    return addBasicAssistantMessage(
      userMessage,
      'Which city should I check the weather for?'
    )
  }

  try {
    const geoUrl =
      'https://geocoding-api.open-meteo.com/v1/search?' +
      new URLSearchParams({
        name: location,
        count: '1',
        language: 'en',
        format: 'json'
      }).toString()
    const geoRes = await fetch(geoUrl)
    if (!geoRes.ok) throw new Error(`Geocoding API ${geoRes.status}`)
    const geoData = (await geoRes.json()) as {
      results?: {
        name: string
        admin1?: string
        country?: string
        latitude: number
        longitude: number
      }[]
    }
    const match = geoData.results?.[0]
    if (!match) {
      return addBasicAssistantMessage(
        userMessage,
        `I couldn't find a weather location for "${location}".`
      )
    }

    const weatherUrl =
      'https://api.open-meteo.com/v1/forecast?' +
      new URLSearchParams({
        latitude: String(match.latitude),
        longitude: String(match.longitude),
        current:
          'temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m',
        temperature_unit: 'fahrenheit',
        wind_speed_unit: 'mph',
        precipitation_unit: 'inch',
        timezone: 'auto'
      }).toString()
    const weatherRes = await fetch(weatherUrl)
    if (!weatherRes.ok) throw new Error(`Weather API ${weatherRes.status}`)
    const weatherData = (await weatherRes.json()) as {
      current?: {
        temperature_2m?: number
        apparent_temperature?: number
        relative_humidity_2m?: number
        precipitation?: number
        weather_code?: number
        wind_speed_10m?: number
      }
    }
    const current = weatherData.current
    if (!current || typeof current.temperature_2m !== 'number') {
      throw new Error('Missing current weather data')
    }

    const place = [match.name, match.admin1, match.country].filter(Boolean).join(', ')
    const description =
      typeof current.weather_code === 'number' ? weatherDescription(current.weather_code) : 'current'
    const feels =
      typeof current.apparent_temperature === 'number'
        ? `, feels like ${Math.round(current.apparent_temperature)}°F`
        : ''
    const humidity =
      typeof current.relative_humidity_2m === 'number'
        ? ` Humidity is ${Math.round(current.relative_humidity_2m)}%.`
        : ''
    const wind =
      typeof current.wind_speed_10m === 'number'
        ? ` Wind is ${Math.round(current.wind_speed_10m)} mph.`
        : ''
    const precip =
      typeof current.precipitation === 'number' && current.precipitation > 0
        ? ` Precipitation is ${current.precipitation.toFixed(2)} in.`
        : ''

    return addBasicAssistantMessage(
      userMessage,
      `The weather in ${place} is ${description} and ${Math.round(
        current.temperature_2m
      )}°F${feels}.${humidity}${wind}${precip}`
    )
  } catch (err) {
    db.addLog('system', `Weather lookup failed: ${(err as Error).message}`)
    return addBasicAssistantMessage(
      userMessage,
      `I couldn't retrieve the current weather for ${location} right now.`
    )
  }
}

function isSummarizeTextRequest(text: string): boolean {
  const lower = text.toLowerCase()
  if (!/\b(summarize|summarise|summary|sum up|tl;dr|tldr)\b/.test(lower)) return false
  return !/\b(plan|plans|today|daily)\b/.test(lower)
}

function extractTextToSummarize(text: string): string | null {
  const trimmed = text.trim()
  const colon = trimmed.match(/\b(?:summarize|summarise|sum up|tl;dr|tldr)\b[^:]*:\s*([\s\S]+)/i)
  let body = colon?.[1]?.trim()

  if (!body) {
    body = trimmed
      .replace(/^\s*(please\s+)?(?:can you\s+|could you\s+)?(?:summarize|summarise|sum up|tl;dr|tldr)\s*/i, '')
      .replace(/^(this|the following|this text|this passage|this paragraph|this article)\s*/i, '')
      .trim()
  }

  if (!body || /^(this|this text|a text|the text|it)$/i.test(body)) return null
  if (body.length < 20) return null
  return body
}

async function trySummarizeTextNow(
  text: string,
  userMessage: Message
): Promise<AssistantResult | null> {
  if (!isSummarizeTextRequest(text)) return null

  const textToSummarize = extractTextToSummarize(text)
  if (!textToSummarize) {
    return addBasicAssistantMessage(
      userMessage,
      'Paste the text you want summarized after the request, like: "summarize: ...".'
    )
  }

  try {
    const summary = await summarizeText(textToSummarize)
    return addBasicAssistantMessage(userMessage, summary || 'I could not produce a summary.')
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'Unknown summary error'
    db.addLog('system', `Summary request failed: ${detail}`)
    return addBasicAssistantMessage(
      userMessage,
      'I could not summarize that text right now. Check your model settings and try again.'
    )
  }
}

function isCallRequest(text: string): boolean {
  const lower = text.toLowerCase()
  if (/\b(open|launch|start|close|quit|exit|shut)\b/.test(lower)) return false
  return /\b(call|phone|facetime|face time)\b/.test(lower)
}

function cleanCallTarget(text: string): string {
  return text
    .replace(/^\s*(hi|hey|hello)[,!]?\s+/i, '')
    .replace(/\b(can you|could you|please|for me)\b/gi, ' ')
    .replace(/\b(audio|video)\s+(call|facetime|face time|phone)\b/gi, ' ')
    .replace(/\b(call|phone|facetime|face time)\b/gi, ' ')
    .replace(/\b(on|with|using|through|via)\s+(facetime|face time|phone|phone app)\b/gi, ' ')
    .replace(/^(to|for)\s+/i, '')
    .replace(/[?.!,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function tryStartCallNow(text: string, userMessage: Message): AssistantResult | null {
  if (!isCallRequest(text)) return null

  const target = cleanCallTarget(text)
  if (!target) {
    return addBasicAssistantMessage(userMessage, 'Who should I call?')
  }

  const result = openSystemUrl(
    `facetime://${encodeURIComponent(target)}`,
    `FaceTime for ${target}`
  )
  const message = result.ok
    ? `Opening FaceTime for ${target}. macOS may ask you to choose or confirm the call.`
    : `This request cannot be fulfilled. AI Assistant could not start a call for ${target}. ${result.reason}`
  if (!result.ok) db.addLog('system', `Call request failed: ${target}: ${result.reason}`)
  const assistantMessage = db.addMessage('assistant', message, 'schedule_app_open')
  return {
    userMessage,
    assistantMessage,
    intent: 'schedule_app_open'
  }
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

function isTaskRemovalRequest(text: string): boolean {
  const lower = text.toLowerCase()
  if (!/\b(remove|delete|cancel|clear)\b/.test(lower)) return false
  if (/\b(reminder|alert|notification)\b/.test(lower)) return false
  return /\b(task|todo|to-do|meeting|appointment|call|event|it|that)\b/.test(lower)
}

function cleanTaskRemovalTitle(text: string): string {
  let title = text
    .replace(/^\s*(hi|hey|hello)[,!]?\s+/i, '')
    .replace(/\b(can you|could you|please|for me|i meant|i mean)\b/gi, ' ')
    .replace(/\b(remove|delete|cancel|clear)\b/gi, ' ')
    .replace(/\b(a|an|the|that|this|it)\b/gi, ' ')
    .replace(/\b(task|todo|to-do)\b/gi, ' ')
    .replace(/\bi\s+(set up|created|scheduled|made|added)\b/gi, ' ')
    .replace(/\b(set up|created|scheduled|made|added)\b/gi, ' ')
    .replace(/\bfor myself\b/gi, ' ')
    .replace(/[?.!,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  title = title.replace(/\bfor\s+([A-Z][a-z]+)$/i, 'with $1')
  const meetingWith = title.match(/\bmeeting\b(?:\s+with)?\s+(.+)$/i)
  if (meetingWith) title = `Meeting with ${meetingWith[1].trim()}`
  return title
}

function normalizedWords(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 1 && !['the', 'for', 'with'].includes(word))
}

function findTaskToDelete(title: string | null): { id: number; title: string } | null {
  if (!title) return null
  const tasks = db.listTasks()
  const normalizedTitle = title.toLowerCase()
  const exact = tasks.find((t) => t.title.toLowerCase() === normalizedTitle)
  if (exact) return { id: exact.id, title: exact.title }

  const titleWords = normalizedWords(title)
  if (titleWords.length === 0) return null

  const scored = tasks
    .map((task) => {
      const taskTitle = task.title.toLowerCase()
      const taskWords = normalizedWords(task.title)
      const wordMatches = titleWords.filter((word) => taskWords.includes(word)).length
      const containsScore =
        taskTitle.includes(normalizedTitle) || normalizedTitle.includes(taskTitle) ? 2 : 0
      return { task, score: wordMatches + containsScore }
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)

  if (scored.length > 1 && scored[0].score === scored[1].score) return null

  const best = scored[0]?.task
  return best ? { id: best.id, title: best.title } : null
}

function previousTaskRemovalTitle(userMessage: Message): string | null {
  const previousUser = db
    .listMessages(10)
    .filter((m) => m.id < userMessage.id && m.role === 'user')
    .reverse()
    .find((m) => isTaskRemovalRequest(m.content))

  const title = previousUser ? cleanTaskRemovalTitle(previousUser.content) : ''
  return title || null
}

function tryDeleteTaskNow(text: string, userMessage: Message): AssistantResult | null {
  if (!isTaskRemovalRequest(text)) return null

  let title = cleanTaskRemovalTitle(text)
  if (!title || /^(task|todo|to-do)$/i.test(title)) {
    title = previousTaskRemovalTitle(userMessage) ?? ''
  }

  const task = findTaskToDelete(title || null)
  if (!task) {
    const message = title
      ? `I couldn't find a task matching ${title}.`
      : 'Which task should I delete?'
    const assistantMessage = db.addMessage('assistant', message, 'create_task')
    return {
      userMessage,
      assistantMessage,
      intent: 'create_task'
    }
  }

  db.deleteTask(task.id)
  const assistantMessage = db.addMessage(
    'assistant',
    `Deleted task: ${task.title}.`,
    'create_task'
  )
  return {
    userMessage,
    assistantMessage,
    intent: 'create_task'
  }
}

function cleanReminderTitle(text: string): string {
  return text
    .replace(/^\s*(hi|hey|hello)[,!]?\s+/i, '')
    .replace(/\bin\s+\d+\s*(second|seconds|sec|secs|minute|minutes|min|hour|hours|hr|hrs|day|days)\b/gi, '')
    .replace(/\b(?:on\s+)?\d{1,2}\/\d{1,2}\/\d{2,4}(?:\s+(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?/gi, '')
    .replace(/\btomorrow(?:\s+(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?/gi, '')
    .replace(/^(please\s+)?(set|create|add|make)\s+(a\s+)?(new\s+)?reminder\s*/i, '')
    .replace(/^remind\s+me\s*/i, '')
    .replace(/^(to|for|about)\s+/i, '')
    .replace(/^(a|an|the)\s+/i, '')
    .replace(/\s+(for me|for myself)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function isReminderRequest(text: string): boolean {
  return /\b(remind me|set\s+(a\s+)?reminder|create\s+(a\s+)?reminder|add\s+(a\s+)?reminder)\b/i.test(
    text
  )
}

function formatReminderTime(datetime: string): string {
  return new Date(datetime).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}

function pendingReminderTitle(userMessage: Message): string | null {
  const previousAssistant = db
    .listMessages(8)
    .filter(
      (m) =>
        m.id < userMessage.id &&
        m.role === 'assistant' &&
        m.intent === 'create_reminder'
    )
    .at(-1)

  const match = previousAssistant?.content.match(/^When should I remind you about (.+)\?$/i)
  return match?.[1]?.trim() ?? null
}

function tryCompletePendingReminder(text: string, userMessage: Message): AssistantResult | null {
  if (isReminderRequest(text)) return null

  const title = pendingReminderTitle(userMessage)
  if (!title) return null

  const datetime = parseDateFromTaskText(text)
  if (!datetime) {
    const assistantMessage = db.addMessage(
      'assistant',
      `I still need a date or time for ${title}.`,
      'create_reminder'
    )
    return {
      userMessage,
      assistantMessage,
      intent: 'create_reminder'
    }
  }

  db.addReminder(title, datetime, 'none')
  const assistantMessage = db.addMessage(
    'assistant',
    `Reminder set: ${title}. I’ll remind you ${formatReminderTime(datetime)}.`,
    'create_reminder'
  )
  return {
    userMessage,
    assistantMessage,
    intent: 'create_reminder'
  }
}

function isReminderRemovalRequest(text: string): boolean {
  return /\b(remove|delete|cancel|dismiss|clear)\b/i.test(text) && /\b(reminder|that|it)\b/i.test(text)
}

function cleanReminderRemovalTitle(text: string): string {
  return text
    .replace(/^\s*(hi|hey|hello)[,!]?\s+/i, '')
    .replace(/\b(can you|could you|please|for me|i meant|i mean)\b/gi, ' ')
    .replace(/\bin\s+\d+\s*(second|seconds|sec|secs|minute|minutes|min|hour|hours|hr|hrs|day|days)\b/gi, ' ')
    .replace(/\b(?:on\s+)?\d{1,2}\/\d{1,2}\/\d{2,4}(?:\s+(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?/gi, ' ')
    .replace(/\btomorrow(?:\s+(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?/gi, ' ')
    .replace(/\b(remove|delete|cancel|dismiss|clear)\b/gi, ' ')
    .replace(/\b(a|an|the|that|this|it)\b/gi, ' ')
    .replace(/\b(reminder|alert|notification)\b/gi, ' ')
    .replace(/\b(to|for|about|called|named)\b/gi, ' ')
    .replace(/[?.!,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function lastCreatedReminderTitle(userMessage: Message): string | null {
  const matches = db
    .listMessages(12)
    .filter(
      (m) =>
        m.id < userMessage.id &&
        m.role === 'assistant' &&
        m.intent === 'create_reminder'
    )
    .map((m) => m.content.match(/^Reminder set: (.+?)\. I’ll remind you /i)?.[1]?.trim())
    .filter((title): title is string => !!title)

  return matches.at(-1) ?? null
}

function findActiveReminder(title: string | null): { id: number; title: string } | null {
  const reminders = db.listReminders()
  if (!title) return null

  const normalizedTitle = title.toLowerCase()
  const exact = reminders.find((r) => r.title.toLowerCase() === normalizedTitle)
  if (exact) return { id: exact.id, title: exact.title }

  const titleWords = normalizedWords(title)
  if (titleWords.length === 0) return null

  const scored = reminders
    .map((reminder) => {
      const reminderTitle = reminder.title.toLowerCase()
      const reminderWords = normalizedWords(reminder.title)
      const wordMatches = titleWords.filter((word) => reminderWords.includes(word)).length
      const containsScore =
        reminderTitle.includes(normalizedTitle) || normalizedTitle.includes(reminderTitle) ? 2 : 0
      return { reminder, score: wordMatches + containsScore }
    })
    .filter(({ score }) => score >= Math.min(2, titleWords.length))
    .sort((a, b) => b.score - a.score)

  if (scored.length > 1 && scored[0].score === scored[1].score) return null

  const best = scored[0]?.reminder
  return best ? { id: best.id, title: best.title } : null
}

function previousReminderRemovalTitle(userMessage: Message): string | null {
  const previousUser = db
    .listMessages(12)
    .filter((m) => m.id < userMessage.id && m.role === 'user')
    .reverse()
    .find((m) => isReminderRemovalRequest(m.content))

  const title = previousUser ? cleanReminderRemovalTitle(previousUser.content) : ''
  return title || null
}

function hasPendingReminderRemoval(userMessage: Message): boolean {
  return db
    .listMessages(8)
    .some(
      (m) =>
        m.id < userMessage.id &&
        m.role === 'assistant' &&
        m.intent === 'create_reminder' &&
        (/^Which reminder should I remove\?$/i.test(m.content) ||
          /^I couldn't find an active reminder for .+\.$/i.test(m.content))
    )
}

function removeReminderByTitle(
  title: string | null,
  userMessage: Message
): AssistantResult {
  const reminder = findActiveReminder(title)

  if (!reminder) {
    const message = title
      ? `I couldn't find an active reminder for ${title}.`
      : 'Which reminder should I remove?'
    const assistantMessage = db.addMessage('assistant', message, 'create_reminder')
    return {
      userMessage,
      assistantMessage,
      intent: 'create_reminder'
    }
  }

  db.dismissReminder(reminder.id)
  const assistantMessage = db.addMessage(
    'assistant',
    `Removed reminder: ${reminder.title}.`,
    'create_reminder'
  )
  return {
    userMessage,
    assistantMessage,
    intent: 'create_reminder'
  }
}

function tryRemoveReminderNow(text: string, userMessage: Message): AssistantResult | null {
  if (!isReminderRemovalRequest(text)) return null

  const typedTitle = cleanReminderRemovalTitle(text)
  const contextTitle = /^(that|this|it)?\s*(reminder)?$/i.test(typedTitle)
    ? previousReminderRemovalTitle(userMessage) ?? lastCreatedReminderTitle(userMessage)
    : typedTitle
  return removeReminderByTitle(contextTitle || lastCreatedReminderTitle(userMessage), userMessage)
}

function tryCompleteReminderRemoval(text: string, userMessage: Message): AssistantResult | null {
  const hasReminderReference = /\b(reminder|that|it)\b/i.test(text)
  if (!hasPendingReminderRemoval(userMessage) && !hasReminderReference) return null

  const typedTitle = cleanReminderRemovalTitle(text)
  const title = typedTitle || previousReminderRemovalTitle(userMessage) || lastCreatedReminderTitle(userMessage)
  if (!title && !hasPendingReminderRemoval(userMessage)) return null

  return removeReminderByTitle(title || null, userMessage)
}

function tryCreateReminderNow(text: string, userMessage: Message): AssistantResult | null {
  if (!isReminderRequest(text)) return null
  const datetime = parseDateFromTaskText(text)
  let title = cleanReminderTitle(text)
  if (/^(it|this|that)$/i.test(title)) title = ''

  if (!datetime) {
    const message = title
      ? `When should I remind you about ${title}?`
      : 'What should I remind you about, and when?'
    const assistantMessage = db.addMessage('assistant', message, 'create_reminder')
    return {
      userMessage,
      assistantMessage,
      intent: 'create_reminder'
    }
  }

  if (!title) title = 'Reminder'

  db.addReminder(title, datetime, 'none')
  const assistantMessage = db.addMessage(
    'assistant',
    `Reminder set: ${title}. I’ll remind you ${formatReminderTime(datetime)}.`,
    'create_reminder'
  )
  return {
    userMessage,
    assistantMessage,
    intent: 'create_reminder'
  }
}

function tryOpenAppNow(text: string, userMessage: Message): AssistantResult | null {
  if (!hasImmediateOpenIntent(text)) return null

  const label = resolveApp(text)
  if (!label) {
    const message =
      'This request cannot be fulfilled. AI Assistant can currently open only these apps: ' +
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
    : `This request cannot be fulfilled. AI Assistant could not open ${label}. ${result.reason}`
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
      'This request cannot be fulfilled. AI Assistant can currently close only these apps: ' +
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
    : `This request cannot be fulfilled. AI Assistant could not close ${label}. ${result.reason}`
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

function tryBrowserSiteClose(text: string, userMessage: Message): AssistantResult | null {
  if (!hasBrowserSiteCloseIntent(text)) return null

  const result = closeKnownSite(text)
  const message = result.ok
    ? `Closed ${result.site} in ${result.browser}.`
    : `This request cannot be fulfilled. ${result.reason}`
  const assistantMessage = db.addMessage('assistant', message, 'schedule_app_open')
  if (!result.ok) db.addLog('system', `Browser close action failed: ${result.reason}`)
  return {
    userMessage,
    assistantMessage,
    intent: 'schedule_app_open'
  }
}

function tryScheduleBrowserSiteAction(text: string, userMessage: Message): AssistantResult | null {
  const datetime = parseRelativeDate(text)
  if (!datetime) return null

  const lower = text.toLowerCase()
  const kind = /\b(close|quit|exit|shut)\b/.test(lower)
    ? 'close'
    : /\b(open|launch|start|go to|navigate to)\b/.test(lower)
      ? 'open'
      : null
  if (!kind) return null

  const action = browserSiteActionFromText(text, kind)
  if (!action) return null

  db.addScheduledAction(action.browser, datetime, 'approved', encodeBrowserActionNote(action))
  const when = new Date(datetime).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit'
  })
  const verb = action.kind === 'open' ? 'open' : 'close'
  const assistantMessage = db.addMessage(
    'assistant',
    `Scheduled ${action.site} to ${verb} in ${action.browser} at ${when}.`,
    'schedule_app_open'
  )
  return { userMessage, assistantMessage, intent: 'schedule_app_open' }
}

function tryScheduleAppOpen(text: string, userMessage: Message): AssistantResult | null {
  const lower = text.toLowerCase()
  if (!/\b(open|launch|start)\b/.test(lower)) return null

  const datetime = parseRelativeDate(text)
  if (!datetime) return null

  const label = resolveApp(text)
  if (!label) {
    const message =
      'This request cannot be fulfilled. AI Assistant can currently schedule only these apps: ' +
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

    const timeResult = tryTellTimeNow(text.trim(), userMessage)
    if (timeResult) {
      emit({ type: 'data-changed' })
      return timeResult
    }

    const weatherResult = await tryWeatherNow(text.trim(), userMessage)
    if (weatherResult) {
      emit({ type: 'data-changed' })
      return weatherResult
    }

    const summaryResult = await trySummarizeTextNow(text.trim(), userMessage)
    if (summaryResult) {
      emit({ type: 'data-changed' })
      return summaryResult
    }

    const callResult = tryStartCallNow(text.trim(), userMessage)
    if (callResult) {
      emit({ type: 'data-changed' })
      return callResult
    }

    const scheduledBrowserResult = tryScheduleBrowserSiteAction(text.trim(), userMessage)
    if (scheduledBrowserResult) {
      emit({ type: 'data-changed' })
      return scheduledBrowserResult
    }

    const scheduledOpenResult = tryScheduleAppOpen(text.trim(), userMessage)
    if (scheduledOpenResult) {
      emit({ type: 'data-changed' })
      return scheduledOpenResult
    }

    const browserSiteCloseResult = tryBrowserSiteClose(text.trim(), userMessage)
    if (browserSiteCloseResult) {
      emit({ type: 'data-changed' })
      return browserSiteCloseResult
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

    const removeReminderResult = tryRemoveReminderNow(text.trim(), userMessage)
    if (removeReminderResult) {
      emit({ type: 'data-changed' })
      return removeReminderResult
    }

    const completeReminderRemovalResult = tryCompleteReminderRemoval(text.trim(), userMessage)
    if (completeReminderRemovalResult) {
      emit({ type: 'data-changed' })
      return completeReminderRemovalResult
    }

    const deleteTaskResult = tryDeleteTaskNow(text.trim(), userMessage)
    if (deleteTaskResult) {
      emit({ type: 'data-changed' })
      return deleteTaskResult
    }

    const pendingReminderResult = tryCompletePendingReminder(text.trim(), userMessage)
    if (pendingReminderResult) {
      emit({ type: 'data-changed' })
      return pendingReminderResult
    }

    const immediateReminderResult = tryCreateReminderNow(text.trim(), userMessage)
    if (immediateReminderResult) {
      emit({ type: 'data-changed' })
      return immediateReminderResult
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
    const tasksToCreate =
      res.intent === 'create_task' || res.intent === 'summarize_plan' ? res.tasks : []
    const remindersToCreate =
      res.intent === 'create_reminder' || res.intent === 'summarize_plan' ? res.reminders : []
    const scheduledActionsToCreate =
      res.intent === 'schedule_app_open' ? res.scheduledActions : []

    for (const t of tasksToCreate) db.addTask(t.title, t.due ?? null)
    for (const r of remindersToCreate)
      db.addReminder(r.title, r.datetime, r.recurrence)

    const rejected: string[] = []
    for (const sa of scheduledActionsToCreate) {
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
