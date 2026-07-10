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
  runGeneralChat,
  rewriteText,
  summarizeText,
  summarizeWritingProfile,
  transcribeAudio,
  AssistantError
} from './assistant'
import { startScheduler, stopScheduler, executeAction } from './scheduler'
import {
  createMacCalendarEventForTask,
  createMacReminder,
  deleteMacCalendarEventForTask,
  deleteMacReminder
} from './macNative'

let win: BrowserWindow | null = null
let expanded = false
let resizeSaveTimer: ReturnType<typeof setTimeout> | null = null

const COLLAPSED = { width: 168, height: 64 }
const LEGACY_EXPANDED_DEFAULT = { width: 348, height: 500 }
const EXPANDED_DEFAULT = { width: 312, height: 430 }
const EXPANDED_MIN = { width: 276, height: 300 }
const EXPANDED_MAX = { width: 720, height: 900 }
const MARGIN = 16

function clampSize(
  size: { width: number; height: number },
  min = EXPANDED_MIN,
  max = EXPANDED_MAX
): { width: number; height: number } {
  return {
    width: Math.min(Math.max(size.width, min.width), max.width),
    height: Math.min(Math.max(size.height, min.height), max.height)
  }
}

function expandedWindowSize(): { width: number; height: number } {
  const saved = db.getExpandedWindowSize()
  if (
    saved &&
    saved.width === LEGACY_EXPANDED_DEFAULT.width &&
    saved.height === LEGACY_EXPANDED_DEFAULT.height
  ) {
    return EXPANDED_DEFAULT
  }
  return clampSize(saved ?? EXPANDED_DEFAULT)
}

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
  if (expanded) {
    win.setResizable(true)
    win.setMaximumSize(EXPANDED_MAX.width, EXPANDED_MAX.height)
    win.setMinimumSize(EXPANDED_MIN.width, EXPANDED_MIN.height)
  } else {
    win.setMinimumSize(COLLAPSED.width, COLLAPSED.height)
    win.setMaximumSize(COLLAPSED.width, COLLAPSED.height)
    win.setResizable(false)
  }
  const size = expanded ? expandedWindowSize() : COLLAPSED
  const { x, y } = positionFor(size)
  win.setBounds({ x, y, width: size.width, height: size.height }, false)
}

function resizeExpandedBounds(bounds: {
  x: number
  y: number
  width: number
  height: number
}): { x: number; y: number; width: number; height: number } | null {
  if (!win || !expanded) return null

  const { workArea } = screen.getPrimaryDisplay()
  const size = clampSize(bounds)
  const minX = workArea.x + MARGIN
  const minY = workArea.y + MARGIN
  const maxX = workArea.x + workArea.width - size.width - MARGIN
  const maxY = workArea.y + workArea.height - size.height - MARGIN
  const next = {
    x: Math.min(Math.max(bounds.x, minX), maxX),
    y: Math.min(Math.max(bounds.y, minY), maxY),
    width: size.width,
    height: size.height
  }

  win.setBounds(next, false)
  db.setExpandedWindowSize(next.width, next.height)
  return next
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
    minWidth: COLLAPSED.width,
    minHeight: COLLAPSED.height,
    maxWidth: COLLAPSED.width,
    maxHeight: COLLAPSED.height,
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
  win.on('resize', () => {
    if (!win || !expanded) return
    if (resizeSaveTimer) clearTimeout(resizeSaveTimer)
    resizeSaveTimer = setTimeout(() => {
      if (!win || !expanded) return
      const [width, height] = win.getSize()
      db.setExpandedWindowSize(width, height)
    }, 250)
  })
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

function cleanEmailBodyForDisplay(body: string): string {
  return body
    .replace(/\n{1,}\s*(?:Note|Notes|P\.S\. about the draft):[\s\S]*$/i, '')
    .replace(/\n{1,}\s*\([^)]*(?:removed|changed|adjusted|revised|tone|formal|informal)[^)]*\)\s*$/i, '')
    .trim()
}

function formatEmailDraft(email: {
  to?: string
  subject?: string
  body: string
}): string {
  const parts = ['Draft email:']
  if (email.to) parts.push(`To: ${email.to}`)
  if (email.subject) parts.push(`Subject: ${email.subject}`)
  parts.push('', cleanEmailBodyForDisplay(email.body))
  return parts.join('\n')
}

function syncTaskToMacCalendar(title: string, due: string | null): void {
  if (!due) return
  void createMacCalendarEventForTask(title, due).then((result) => {
    if (!result.ok && !result.skipped) {
      db.addLog('system', `Calendar sync failed for task "${title}": ${result.reason}`)
    }
  })
}

function syncReminderToMac(title: string, datetime: string): void {
  void createMacReminder(title, datetime).then((result) => {
    if (!result.ok && !result.skipped) {
      db.addLog('system', `Reminders sync failed for "${title}": ${result.reason}`)
    }
  })
}

function removeTaskFromMacCalendar(title: string, due: string | null): void {
  if (!due) return
  void deleteMacCalendarEventForTask(title, due).then((result) => {
    if (!result.ok && !result.skipped) {
      db.addLog('system', `Calendar removal failed for task "${title}": ${result.reason}`)
    }
  })
}

function removeReminderFromMac(title: string, datetime: string): void {
  void deleteMacReminder(title, datetime).then((result) => {
    if (!result.ok && !result.skipped) {
      db.addLog('system', `Reminders removal failed for "${title}": ${result.reason}`)
    }
  })
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
    'Please try rephrasing the request or use a supported command. Try /help to see examples.'
  )
}

function withHelpHint(message: string): string {
  if (message.includes('/help')) return message
  return `${message} Try /help to see examples.`
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

function tryHelpCommand(text: string, userMessage: Message): AssistantResult | null {
  const normalized = text.trim().toLowerCase()
  const isHelp =
    normalized === '/help' ||
    normalized === 'help' ||
    normalized === 'commands' ||
    /\b(what can you do|show commands|supported commands|how do i use)\b/.test(normalized)
  if (!isHelp) return null

  return addBasicAssistantMessage(
    userMessage,
    [
      'Here are useful things you can ask me to do:',
      '',
      '- Writing: `rewrite this: paste text here`, `summarize: paste text here`, or `summarize this article: https://...`',
      '- Live info: `weather in NYC`, `META stock price`, `current market movers`',
      '- Time: `what time is it in London?`, `convert 5pm PST to EST`, or `when is 5-7pm PST to EST`',
      '- Tasks: `create a task to call Derek tomorrow at 2pm`',
      '- Reminders: `remind me in 1 hour to leave work`',
      '- Edit/delete: `move that reminder to 10pm`, `delete the meeting task`, `remove all tasks and reminders`',
      '- Apps/sites: `open Slack`, `open Gmail in Chrome`, `close Gmail in Chrome`, `open Chrome in 10 minutes`',
      '- Email: `write an email to Rose about the referral inquiry`',
      '',
      'Voice input works with the same natural phrases.'
    ].join('\n')
  )
}

function tryTellTimeNow(text: string, userMessage: Message): AssistantResult | null {
  const lower = text.toLowerCase()
  const asksForTravelTime =
    /\b(walk|walking|drive|driving|transit|train|subway|bus|bike|biking|distance|route|directions?)\b/.test(
      lower
    )
  if (asksForTravelTime) return null

  const isTimeRequest =
    /\b(what'?s|what is|tell me|show me|give me)\b.*\b(?:the\s+)?(?:current\s+|local\s+)?(time|date|day)\b/.test(
      lower
    ) ||
    /\b(what time is it|what'?s the time|time now|date now|current time|local time|current date|today'?s date)\b/.test(
      lower
    )
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

interface FixedTimeZone {
  label: string
  offsetMinutes: number
}

const FIXED_TIME_ZONES: Record<string, FixedTimeZone> = {
  pst: { label: 'PST', offsetMinutes: -8 * 60 },
  pdt: { label: 'PDT', offsetMinutes: -7 * 60 },
  mst: { label: 'MST', offsetMinutes: -7 * 60 },
  mdt: { label: 'MDT', offsetMinutes: -6 * 60 },
  cst: { label: 'CST', offsetMinutes: -6 * 60 },
  cdt: { label: 'CDT', offsetMinutes: -5 * 60 },
  est: { label: 'EST', offsetMinutes: -5 * 60 },
  edt: { label: 'EDT', offsetMinutes: -4 * 60 },
  pt: { label: 'PT', offsetMinutes: -8 * 60 },
  mt: { label: 'MT', offsetMinutes: -7 * 60 },
  ct: { label: 'CT', offsetMinutes: -6 * 60 },
  et: { label: 'ET', offsetMinutes: -5 * 60 }
}

function parseFixedTimeZone(value: string): FixedTimeZone | null {
  return FIXED_TIME_ZONES[value.toLowerCase()] ?? null
}

function formatConvertedClock(totalMinutes: number): { time: string; dayNote: string } {
  const dayShift = Math.floor(totalMinutes / 1440)
  const normalized = ((totalMinutes % 1440) + 1440) % 1440
  const hour24 = Math.floor(normalized / 60)
  const minute = normalized % 60
  const hour12 = hour24 % 12 || 12
  const meridiem = hour24 >= 12 ? 'PM' : 'AM'
  const minuteText = minute === 0 ? '' : `:${String(minute).padStart(2, '0')}`
  const dayNote = dayShift > 0 ? ' next day' : dayShift < 0 ? ' previous day' : ''
  return { time: `${hour12}${minuteText} ${meridiem}`, dayNote }
}

function parseClockMinutes(
  hourText: string,
  minuteText: string | undefined,
  meridiemText: string
): number | null {
  let hour = Number(hourText)
  const minute = minuteText ? Number(minuteText) : 0
  const meridiem = meridiemText.toLowerCase()
  if (hour < 1 || hour > 12 || minute < 0 || minute > 59) return null
  if (meridiem === 'pm' && hour < 12) hour += 12
  if (meridiem === 'am' && hour === 12) hour = 0
  return hour * 60 + minute
}

function formatConvertedRange(startMinutes: number, endMinutes: number): {
  time: string
  dayNote: string
} {
  const start = formatConvertedClock(startMinutes)
  const end = formatConvertedClock(endMinutes)
  const dayNote =
    start.dayNote && start.dayNote === end.dayNote
      ? start.dayNote
      : start.dayNote || end.dayNote
  return { time: `${start.time}-${end.time}`, dayNote }
}

function tryConvertTimeZone(text: string, userMessage: Message): AssistantResult | null {
  const rangeMatch = text.match(
    /\b(?:convert|what(?:'s| is)|when(?:'s| is)|change)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:-|to|through|until)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s+([a-z]{2,4})\s+(?:to|in|into)\s+([a-z]{2,4})\b/i
  )
  if (rangeMatch) {
    const source = parseFixedTimeZone(rangeMatch[7])
    const target = parseFixedTimeZone(rangeMatch[8])
    if (!source || !target) return null

    const firstMeridiem = rangeMatch[3] ?? rangeMatch[6]
    const sourceStart = parseClockMinutes(rangeMatch[1], rangeMatch[2], firstMeridiem)
    const sourceEnd = parseClockMinutes(rangeMatch[4], rangeMatch[5], rangeMatch[6])
    if (sourceStart === null || sourceEnd === null) return null

    const offset = target.offsetMinutes - source.offsetMinutes
    const converted = formatConvertedRange(sourceStart + offset, sourceEnd + offset)
    const sourceRange = formatConvertedRange(sourceStart, sourceEnd)

    return addBasicAssistantMessage(
      userMessage,
      `${sourceRange.time} ${source.label} is ${converted.time} ${target.label}${converted.dayNote}.`
    )
  }

  const match = text.match(
    /\b(?:convert|what(?:'s| is)|when(?:'s| is)|change)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s+([a-z]{2,4})\s+(?:to|in|into)\s+([a-z]{2,4})\b/i
  )
  if (!match) return null

  const source = parseFixedTimeZone(match[4])
  const target = parseFixedTimeZone(match[5])
  if (!source || !target) return null

  const sourceMinutes = parseClockMinutes(match[1], match[2], match[3])
  if (sourceMinutes === null) return null
  const targetMinutes = sourceMinutes - source.offsetMinutes + target.offsetMinutes
  const converted = formatConvertedClock(targetMinutes)

  return addBasicAssistantMessage(
    userMessage,
    `${formatConvertedClock(sourceMinutes).time} ${source.label} is ${converted.time} ${
      target.label
    }${converted.dayNote}.`
  )
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

function isEmailDraftLikeRequest(text: string): boolean {
  return (
    /\b(write|draft|compose|generate|create)\b.*\b(e-?mail|message|reply)\b/i.test(text) ||
    /\b(e-?mail|message|reply)\s+to\b/i.test(text)
  )
}

function isWeatherRequest(text: string): boolean {
  return (
    /\b(weather|temperature|forecast|conditions)\b/i.test(text) ||
    /\b(what'?s|what is|how'?s|how is)\s+(it|outside)\s+(right now|now|currently)?\s*(in|at|near)\b/i.test(
      text
    )
  )
}

function normalizeWeatherLocation(location: string): string | null {
  const cleaned = location
    .replace(/\b(today|right now|now|currently|outside)\b/gi, ' ')
    .replace(/\s+(also|and also|plus|with)\b[\s\S]*$/i, ' ')
    .replace(/\band\s+add\b[\s\S]*$/i, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (!cleaned || /^(here|outside|today|now|right now)$/i.test(cleaned)) return null
  if (/^(nyc|new york city)$/i.test(cleaned)) return 'New York City'
  if (/^(la)$/i.test(cleaned)) return 'Los Angeles'
  return cleaned
}

function extractWeatherLocation(text: string): string | null {
  const cleaned = text
    .replace(/[?.!,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  const explicit = cleaned.match(
    /\b(?:weather|temperature|forecast|conditions|outside|it)?\s*(?:in|for|at|near)\s+(.+?)(?:\s+(?:today|right now|now|currently|also|and\s+add|please)\b|$)/i
  )
  let location = explicit?.[1]?.trim()

  if (!location) {
    location = cleaned
      .replace(/\b(what'?s|what is|how'?s|how is|tell me|show me|give me|current|today'?s|today|right now|now)\b/gi, ' ')
      .replace(/\b(the|weather|temperature|forecast|like|outside|conditions)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  }

  return normalizeWeatherLocation(location)
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

function nwsHeaders(): Record<string, string> {
  return {
    accept: 'application/geo+json',
    'user-agent': 'AI Assistant desktop app (personal use)'
  }
}

function celsiusToFahrenheit(value: number): number {
  return (value * 9) / 5 + 32
}

function kmhToMph(value: number): number {
  return value * 0.621371
}

function metersToInches(value: number): number {
  return value * 39.3701
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function compassFromDegrees(value: number | null): string | null {
  if (value === null) return null
  const directions = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
  return directions[Math.round(value / 45) % directions.length]
}

async function tryNwsObservationText(
  pointData: { properties?: { observationStations?: string } },
  place: string
): Promise<string | null> {
  const stationsUrl = pointData.properties?.observationStations
  if (!stationsUrl) return null

  const stationsRes = await fetch(stationsUrl, { headers: nwsHeaders() })
  if (!stationsRes.ok) throw new Error(`NWS stations API ${stationsRes.status}`)
  const stationsData = (await stationsRes.json()) as {
    features?: {
      id?: string
      properties?: {
        stationIdentifier?: string
        name?: string
      }
    }[]
  }

  for (const station of stationsData.features?.slice(0, 4) ?? []) {
    const stationUrl =
      station.id ??
      (station.properties?.stationIdentifier
        ? `https://api.weather.gov/stations/${station.properties.stationIdentifier}`
        : null)
    if (!stationUrl) continue

    try {
      const observationRes = await fetch(`${stationUrl}/observations/latest`, {
        headers: nwsHeaders()
      })
      if (!observationRes.ok) continue
      const observationData = (await observationRes.json()) as {
        properties?: {
          textDescription?: string | null
          temperature?: { value?: number | null }
          relativeHumidity?: { value?: number | null }
          windSpeed?: { value?: number | null }
          windDirection?: { value?: number | null }
          precipitationLastHour?: { value?: number | null }
        }
      }
      const props = observationData.properties
      const tempC = numberValue(props?.temperature?.value)
      if (tempC === null) continue

      const description = props?.textDescription?.trim().toLowerCase() || 'current'
      const humidity = numberValue(props?.relativeHumidity?.value)
      const windKmh = numberValue(props?.windSpeed?.value)
      const windDirection = compassFromDegrees(numberValue(props?.windDirection?.value))
      const precipMeters = numberValue(props?.precipitationLastHour?.value)
      const stationName = station.properties?.name?.trim()
      const humidityText = humidity !== null ? ` Humidity is ${Math.round(humidity)}%.` : ''
      const windText =
        windKmh !== null
          ? ` Wind is ${Math.round(kmhToMph(windKmh))} mph${
              windDirection ? ` ${windDirection}` : ''
            }.`
          : ''
      const precipText =
        precipMeters !== null && precipMeters > 0
          ? ` Rainfall in the last hour is ${metersToInches(precipMeters).toFixed(2)} in.`
          : ''
      const stationText = stationName ? ` (${stationName})` : ''

      return `The weather in ${place} is ${description} and ${Math.round(
        celsiusToFahrenheit(tempC)
      )}°F.${humidityText}${windText}${precipText}\n\nSource: National Weather Service latest observation${stationText}.`
    } catch (err) {
      db.addLog('system', `NWS station observation failed: ${(err as Error).message}`)
    }
  }

  return null
}

async function tryNwsWeatherText(
  latitude: number,
  longitude: number,
  place: string
): Promise<string> {
  const pointRes = await fetch(
    `https://api.weather.gov/points/${latitude.toFixed(4)},${longitude.toFixed(4)}`,
    { headers: nwsHeaders() }
  )
  if (!pointRes.ok) throw new Error(`NWS points API ${pointRes.status}`)
  const pointData = (await pointRes.json()) as {
    properties?: {
      observationStations?: string
      forecastHourly?: string
    }
  }
  const observationText = await tryNwsObservationText(pointData, place)
  if (observationText) return observationText

  const hourlyUrl = pointData.properties?.forecastHourly
  if (!hourlyUrl) throw new Error('NWS hourly forecast URL missing')

  const hourlyRes = await fetch(hourlyUrl, { headers: nwsHeaders() })
  if (!hourlyRes.ok) throw new Error(`NWS hourly forecast ${hourlyRes.status}`)
  const hourlyData = (await hourlyRes.json()) as {
    properties?: {
      periods?: {
        temperature?: number
        temperatureUnit?: string
        shortForecast?: string
        windSpeed?: string
        windDirection?: string
        relativeHumidity?: { value?: number | null }
        probabilityOfPrecipitation?: { value?: number | null }
      }[]
    }
  }
  const current = hourlyData.properties?.periods?.[0]
  if (!current || typeof current.temperature !== 'number') {
    throw new Error('NWS hourly forecast data missing')
  }

  const condition = current.shortForecast ? `${current.shortForecast.toLowerCase()} and ` : ''
  const unit = current.temperatureUnit ?? 'F'
  const humidity =
    typeof current.relativeHumidity?.value === 'number'
      ? ` Humidity is ${Math.round(current.relativeHumidity.value)}%.`
      : ''
  const precip =
    typeof current.probabilityOfPrecipitation?.value === 'number'
      ? ` Chance of precipitation is ${Math.round(current.probabilityOfPrecipitation.value)}%.`
      : ''
  const wind =
    current.windSpeed || current.windDirection
      ? ` Wind is ${[current.windDirection, current.windSpeed].filter(Boolean).join(' ')}.`
      : ''

  return `The weather in ${place} is ${condition}${Math.round(
    current.temperature
  )}°${unit}.${humidity}${wind}${precip}\n\nSource: National Weather Service hourly forecast.`
}

interface WeatherGeoMatch {
  name: string
  admin1?: string
  country?: string
  country_code?: string
  latitude: number
  longitude: number
}

function weatherPlace(match: WeatherGeoMatch): string {
  return [match.name, match.admin1, match.country].filter(Boolean).join(', ')
}

async function geocodeWeatherLocation(location: string): Promise<WeatherGeoMatch | null> {
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
    results?: WeatherGeoMatch[]
  }
  return geoData.results?.[0] ?? null
}

async function openMeteoWeatherText(match: WeatherGeoMatch): Promise<string> {
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

  return `The weather in ${weatherPlace(match)} is ${description} and ${Math.round(
    current.temperature_2m
  )}°F${feels}.${humidity}${wind}${precip}\n\nSource: Open-Meteo current conditions.`
}

async function lookupWeatherText(location: string): Promise<string | null> {
  const match = await geocodeWeatherLocation(location)
  if (!match) return null

  const place = weatherPlace(match)
  if (match.country_code === 'US' || match.country === 'United States') {
    try {
      return await tryNwsWeatherText(match.latitude, match.longitude, place)
    } catch (err) {
      db.addLog('system', `NWS weather lookup failed: ${(err as Error).message}`)
    }
  }

  return openMeteoWeatherText(match)
}

function requestedSignature(text: string): string | null {
  const match = text.match(/\bsignature\s+(?:which\s+would\s+be|as|is|:)?\s+([\s\S]+)$/i)
  const signature = match?.[1]?.trim()
  return signature || null
}

function fallbackWeatherEmailBody(text: string, location: string, weatherText: string): string {
  const signature = requestedSignature(text) ?? 'Best regards,\n[my name]'
  return `Hi,\n\nI wanted to send a quick note about the weather in ${location}. ${weatherText.replace(
    /\n\nSource:[\s\S]+$/i,
    ''
  )}\n\n${signature}`
}

async function tryWeatherEmailDraftNow(
  text: string,
  userMessage: Message
): Promise<AssistantResult | null> {
  if (!isEmailDraftLikeRequest(text) || !isWeatherRequest(text)) return null

  const location = extractWeatherLocation(text)
  if (!location) return null

  try {
    const weatherText = await lookupWeatherText(location)
    if (!weatherText) {
      return addBasicAssistantMessage(
        userMessage,
        `I couldn't find a weather location for "${location}".`
      )
    }

    try {
      const res = await runAssistant(
        `${text.trim()}\n\nCurrent weather context to use in the draft:\n${weatherText}\n\nDraft only the email or message requested. Do not create tasks, reminders, or app actions.`
      )
      const intent = res.intent === 'generate_email' && res.email ? 'generate_email' : 'general_chat'
      const responseText =
        res.intent === 'generate_email' && res.email
          ? `${res.response.trim()}\n\n${formatEmailDraft(res.email)}`
          : res.response
      const assistantMessage = db.addMessage('assistant', responseText, intent)
      return {
        userMessage,
        assistantMessage,
        intent,
        email: res.email
      }
    } catch (err) {
      db.addLog('system', `Weather email model draft failed: ${(err as Error).message}`)
      const email = {
        body: fallbackWeatherEmailBody(text, location, weatherText)
      }
      const assistantMessage = db.addMessage(
        'assistant',
        `Here is a draft you can copy and paste.\n\n${formatEmailDraft(email)}`,
        'generate_email'
      )
      return {
        userMessage,
        assistantMessage,
        intent: 'generate_email',
        email
      }
    }
  } catch (err) {
    db.addLog('system', `Weather email lookup failed: ${(err as Error).message}`)
    return addBasicAssistantMessage(
      userMessage,
      `I couldn't retrieve the current weather for ${location} right now.`
    )
  }
}

async function tryWeatherNow(
  text: string,
  userMessage: Message
): Promise<AssistantResult | null> {
  if (!isWeatherRequest(text) || isEmailDraftLikeRequest(text)) return null

  const location = extractWeatherLocation(text)
  if (!location) {
    return addBasicAssistantMessage(
      userMessage,
      'Which city should I check the weather for?'
    )
  }

  try {
    const weatherText = await lookupWeatherText(location)
    if (!weatherText) {
      return addBasicAssistantMessage(
        userMessage,
        `I couldn't find a weather location for "${location}".`
      )
    }
    return addBasicAssistantMessage(userMessage, weatherText)
  } catch (err) {
    db.addLog('system', `Weather lookup failed: ${(err as Error).message}`)
    return addBasicAssistantMessage(
      userMessage,
      `I couldn't retrieve the current weather for ${location} right now.`
    )
  }
}

type YahooScreenerId = 'day_gainers' | 'day_losers' | 'most_actives'

interface MarketMover {
  symbol: string
  name: string
  price: number | null
  change: number | null
  changePercent: number | null
}

interface StockQuote {
  symbol: string
  name: string
  price: number | null
  currency: string
  change: number | null
  changePercent: number | null
  marketState: string | null
  exchange: string | null
  source: string
}

const COMPANY_TICKERS: Record<string, string> = {
  meta: 'META',
  facebook: 'META',
  apple: 'AAPL',
  microsoft: 'MSFT',
  google: 'GOOGL',
  alphabet: 'GOOGL',
  amazon: 'AMZN',
  tesla: 'TSLA',
  nvidia: 'NVDA',
  netflix: 'NFLX',
  amd: 'AMD',
  intel: 'INTC',
  paypal: 'PYPL',
  salesforce: 'CRM',
  oracle: 'ORCL',
  walmart: 'WMT',
  disney: 'DIS',
  boeing: 'BA',
  nike: 'NKE',
  spotify: 'SPOT',
  coinbase: 'COIN',
  robinhood: 'HOOD'
}

function isMarketMoversRequest(text: string): boolean {
  const lower = text.toLowerCase()
  const hasMarketTerm = /\b(stock|stocks|market|markets|equity|equities|ticker|tickers)\b/.test(
    lower
  )
  const hasMoverTerm =
    /\b(mover|movers|moving|moved|gainer|gainers|loser|losers|decliner|decliners|active|actives)\b/.test(
      lower
    )
  const hasRankingTerm = /\b(biggest|top|most|largest|major|best|worst)\b/.test(lower)
  return (
    (hasMarketTerm && (hasMoverTerm || (hasRankingTerm && /\b(up|down)\b/.test(lower)))) ||
    (hasMoverTerm && hasRankingTerm)
  )
}

function isStockQuoteRequest(text: string): boolean {
  const lower = text.toLowerCase()
  if (isMarketMoversRequest(text)) return false
  return (
    /\b(stock|stocks|share|shares|ticker|quote|market cap|finance|yahoo finance)\b/.test(lower) &&
    /\b(price|worth|trading|quote|check|current|right now|today|api)\b/.test(lower)
  )
}

function wantsOnlyGainers(text: string): boolean {
  const lower = text.toLowerCase()
  return /\b(gainer|gainers|up|winner|winners|best)\b/.test(lower) && !wantsOnlyLosers(text)
}

function wantsOnlyLosers(text: string): boolean {
  const lower = text.toLowerCase()
  return /\b(loser|losers|down|decliner|decliners|worst)\b/.test(lower)
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function directTickerFromText(text: string): string | null {
  const cashTicker = text.match(/\$([A-Z]{1,6})(?:\b|$)/)
  if (cashTicker?.[1]) return cashTicker[1]

  const lower = text.toLowerCase()
  for (const [name, symbol] of Object.entries(COMPANY_TICKERS)) {
    if (new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(lower)) {
      return symbol
    }
  }

  const explicitTicker = text.match(/\b(?:ticker|symbol|stock)\s+([A-Z]{1,6})\b/)
  if (explicitTicker?.[1]) return explicitTicker[1]

  const allCaps = text.match(/\b[A-Z]{2,5}\b/g) ?? []
  const ignored = new Set(['API', 'USD', 'NYSE', 'NASDAQ', 'ETF'])
  return allCaps.find((candidate) => !ignored.has(candidate)) ?? null
}

function stockSearchTermFromText(text: string): string | null {
  const cleaned = text
    .replace(/\$[A-Z]{1,6}\b/g, ' ')
    .replace(/\b(what'?s|what is|can you|could you|please|yes|check|for me|use|using)\b/gi, ' ')
    .replace(/\b(the|a|an|current|right now|today|latest|live|real time|real-time)\b/gi, ' ')
    .replace(/\b(stock|stocks|share|shares|ticker|quote|price|worth|trading|finance|yahoo|api|information)\b/gi, ' ')
    .replace(/[?.!,']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned.length >= 2 ? cleaned : null
}

function latestStockTickerFromHistory(currentMessageId: number): string | null {
  const messages = db.listMessages(20)
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message.id === currentMessageId) continue
    if (message.role === 'assistant') {
      const sourceQuote = message.content.match(/\b([A-Z]{1,6})\b[\s\S]*Source: Yahoo Finance/i)
      if (sourceQuote?.[1]) return sourceQuote[1]
      continue
    }
    if (message.role === 'user' && isStockQuoteRequest(message.content)) {
      const symbol = directTickerFromText(message.content)
      if (symbol) return symbol
    }
  }
  return null
}

function isStockQuoteFollowUp(text: string): boolean {
  return /\b(yes|yeah|yep|sure|ok|okay|check|check it|check for me|use yahoo|yahoo finance|use the api|api)\b/i.test(
    text
  )
}

async function resolveStockSymbol(text: string, userMessage: Message): Promise<string | null> {
  const direct = directTickerFromText(text)
  if (direct) return direct

  if (isStockQuoteFollowUp(text)) {
    const previous = latestStockTickerFromHistory(userMessage.id)
    if (previous) return previous
  }

  const searchTerm = stockSearchTermFromText(text)
  if (!searchTerm) return null

  const searchUrl =
    'https://query2.finance.yahoo.com/v1/finance/search?' +
    new URLSearchParams({
      q: searchTerm,
      quotesCount: '1',
      newsCount: '0'
    }).toString()
  const searchRes = await fetch(searchUrl, {
    headers: {
      'user-agent': 'AI Assistant desktop app'
    }
  })
  if (!searchRes.ok) throw new Error(`Yahoo Finance search failed with ${searchRes.status}`)
  const data = (await searchRes.json()) as {
    quotes?: {
      symbol?: unknown
      quoteType?: unknown
      typeDisp?: unknown
    }[]
  }
  const quote = data.quotes?.find((item) => {
    const quoteType = typeof item.quoteType === 'string' ? item.quoteType.toLowerCase() : ''
    const typeDisp = typeof item.typeDisp === 'string' ? item.typeDisp.toLowerCase() : ''
    return quoteType === 'equity' || typeDisp === 'equity'
  })
  return typeof quote?.symbol === 'string' ? quote.symbol.trim().toUpperCase() : null
}

async function fetchYahooQuoteApiStockQuote(symbol: string): Promise<StockQuote | null> {
  const url =
    'https://query1.finance.yahoo.com/v7/finance/quote?' +
    new URLSearchParams({
      symbols: symbol
    }).toString()
  const res = await fetch(url, {
    headers: {
      'user-agent': 'AI Assistant desktop app'
    }
  })
  if (!res.ok) throw new Error(`Yahoo Finance quote failed with ${res.status}`)
  const data = (await res.json()) as {
    quoteResponse?: {
      result?: {
        symbol?: unknown
        shortName?: unknown
        longName?: unknown
        displayName?: unknown
        regularMarketPrice?: unknown
        regularMarketChange?: unknown
        regularMarketChangePercent?: unknown
        currency?: unknown
        marketState?: unknown
        fullExchangeName?: unknown
      }[]
    }
  }
  const quote = data.quoteResponse?.result?.[0]
  if (!quote) return null

  const resolvedSymbol = typeof quote.symbol === 'string' ? quote.symbol.trim() : symbol
  const fallbackName =
    typeof quote.shortName === 'string'
      ? quote.shortName
      : typeof quote.longName === 'string'
        ? quote.longName
        : typeof quote.displayName === 'string'
          ? quote.displayName
          : resolvedSymbol

  return {
    symbol: resolvedSymbol,
    name: fallbackName.trim(),
    price: readNumber(quote.regularMarketPrice),
    currency: typeof quote.currency === 'string' ? quote.currency : 'USD',
    change: readNumber(quote.regularMarketChange),
    changePercent: readNumber(quote.regularMarketChangePercent),
    marketState: typeof quote.marketState === 'string' ? quote.marketState : null,
    exchange: typeof quote.fullExchangeName === 'string' ? quote.fullExchangeName : null,
    source: 'Yahoo Finance quote API'
  }
}

async function fetchYahooChartStockQuote(symbol: string): Promise<StockQuote | null> {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?` +
    new URLSearchParams({
      range: '1d',
      interval: '1m'
    }).toString()
  const res = await fetch(url, {
    headers: {
      'user-agent': 'AI Assistant desktop app'
    }
  })
  if (!res.ok) throw new Error(`Yahoo Finance chart failed with ${res.status}`)
  const data = (await res.json()) as {
    chart?: {
      result?: {
        meta?: {
          symbol?: unknown
          shortName?: unknown
          longName?: unknown
          regularMarketPrice?: unknown
          previousClose?: unknown
          chartPreviousClose?: unknown
          currency?: unknown
          fullExchangeName?: unknown
          exchangeName?: unknown
        }
      }[]
    }
  }
  const meta = data.chart?.result?.[0]?.meta
  if (!meta) return null

  const price = readNumber(meta.regularMarketPrice)
  const previousClose = readNumber(meta.previousClose) ?? readNumber(meta.chartPreviousClose)
  const change = price !== null && previousClose !== null ? price - previousClose : null
  const changePercent =
    change !== null && previousClose !== null && previousClose !== 0
      ? (change / previousClose) * 100
      : null
  const resolvedSymbol = typeof meta.symbol === 'string' ? meta.symbol.trim() : symbol
  const name =
    typeof meta.shortName === 'string'
      ? meta.shortName
      : typeof meta.longName === 'string'
        ? meta.longName
        : resolvedSymbol
  const exchange =
    typeof meta.fullExchangeName === 'string'
      ? meta.fullExchangeName
      : typeof meta.exchangeName === 'string'
        ? meta.exchangeName
        : null

  return {
    symbol: resolvedSymbol,
    name: name.trim(),
    price,
    currency: typeof meta.currency === 'string' ? meta.currency : 'USD',
    change,
    changePercent,
    marketState: null,
    exchange,
    source: 'Yahoo Finance chart API'
  }
}

async function fetchStockQuote(symbol: string): Promise<StockQuote | null> {
  try {
    const quote = await fetchYahooQuoteApiStockQuote(symbol)
    if (quote) return quote
  } catch (err) {
    db.addLog('system', `Yahoo quote endpoint failed: ${(err as Error).message}`)
  }

  return fetchYahooChartStockQuote(symbol)
}

function formatStockQuote(quote: StockQuote): string {
  const price = quote.price === null ? 'not currently available' : `${quote.currency} ${quote.price.toFixed(2)}`
  const change =
    quote.change === null
      ? ''
      : `, ${quote.change >= 0 ? '+' : ''}${quote.change.toFixed(2)}`
  const changePercent =
    quote.changePercent === null
      ? ''
      : ` (${quote.changePercent >= 0 ? '+' : ''}${quote.changePercent.toFixed(2)}%)`
  const exchange = quote.exchange ? ` on ${quote.exchange}` : ''
  const marketState = quote.marketState ? ` Market state: ${quote.marketState}.` : ''
  return `${quote.symbol} (${quote.name}) is trading at ${price}${change}${changePercent}${exchange}.${marketState}\n\nSource: ${quote.source}. This is informational only, not financial advice.`
}

async function tryStockQuoteNow(
  text: string,
  userMessage: Message
): Promise<AssistantResult | null> {
  if (!isStockQuoteRequest(text) && !isStockQuoteFollowUp(text)) return null

  try {
    const symbol = await resolveStockSymbol(text, userMessage)
    if (!symbol) {
      return addBasicAssistantMessage(
        userMessage,
        'Which stock ticker or company should I check?'
      )
    }

    const quote = await fetchStockQuote(symbol)
    if (!quote) {
      return addBasicAssistantMessage(
        userMessage,
        `I couldn't find a Yahoo Finance quote for "${symbol}".`
      )
    }

    return addBasicAssistantMessage(userMessage, formatStockQuote(quote))
  } catch (err) {
    db.addLog('system', `Stock quote lookup failed: ${(err as Error).message}`)
    return addBasicAssistantMessage(
      userMessage,
      "I couldn't retrieve that stock quote from Yahoo Finance right now. Please try again in a moment."
    )
  }
}

async function fetchMarketMovers(screenerId: YahooScreenerId): Promise<MarketMover[]> {
  const url =
    'https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?' +
    new URLSearchParams({
      scrIds: screenerId,
      count: '5'
    }).toString()

  const res = await fetch(url, {
    headers: {
      'user-agent': 'AI Assistant desktop app'
    }
  })
  if (!res.ok) throw new Error(`Market screener ${screenerId} failed with ${res.status}`)

  const data = (await res.json()) as {
    finance?: {
      result?: {
        quotes?: {
          symbol?: unknown
          shortName?: unknown
          longName?: unknown
          displayName?: unknown
          regularMarketPrice?: unknown
          regularMarketChange?: unknown
          regularMarketChangePercent?: unknown
        }[]
      }[]
    }
  }

  const quotes = data.finance?.result?.[0]?.quotes ?? []
  return quotes
    .map((quote) => {
      const symbol = typeof quote.symbol === 'string' ? quote.symbol.trim() : ''
      const fallbackName =
        typeof quote.shortName === 'string'
          ? quote.shortName
          : typeof quote.longName === 'string'
            ? quote.longName
            : typeof quote.displayName === 'string'
              ? quote.displayName
              : symbol
      return {
        symbol,
        name: fallbackName.trim(),
        price: readNumber(quote.regularMarketPrice),
        change: readNumber(quote.regularMarketChange),
        changePercent: readNumber(quote.regularMarketChangePercent)
      }
    })
    .filter((mover) => mover.symbol)
}

function formatMarketMover(mover: MarketMover): string {
  const name = mover.name && mover.name !== mover.symbol ? ` (${mover.name})` : ''
  const price = mover.price === null ? '' : ` at $${mover.price.toFixed(2)}`
  const change =
    mover.change === null
      ? ''
      : `, ${mover.change >= 0 ? '+' : ''}${mover.change.toFixed(2)}`
  const changePercent =
    mover.changePercent === null
      ? ''
      : ` (${mover.changePercent >= 0 ? '+' : ''}${mover.changePercent.toFixed(2)}%)`
  return `- ${mover.symbol}${name}${price}${change}${changePercent}`
}

async function tryMarketMoversNow(
  text: string,
  userMessage: Message
): Promise<AssistantResult | null> {
  if (!isMarketMoversRequest(text)) return null

  const gainersOnly = wantsOnlyGainers(text)
  const losersOnly = wantsOnlyLosers(text)
  const sections: string[] = []

  try {
    if (!losersOnly || gainersOnly) {
      const gainers = await fetchMarketMovers('day_gainers')
      sections.push(
        `Top stock gainers so far:\n${
          gainers.length ? gainers.map(formatMarketMover).join('\n') : '- No gainers returned.'
        }`
      )
    }

    if (!gainersOnly || losersOnly) {
      const losers = await fetchMarketMovers('day_losers')
      sections.push(
        `Top stock losers so far:\n${
          losers.length ? losers.map(formatMarketMover).join('\n') : '- No losers returned.'
        }`
      )
    }

    return addBasicAssistantMessage(
      userMessage,
      `${sections.join(
        '\n\n'
      )}\n\nSource: Yahoo Finance market screener. This is informational only, not financial advice.`
    )
  } catch (err) {
    db.addLog('system', `Market movers lookup failed: ${(err as Error).message}`)
    return addBasicAssistantMessage(
      userMessage,
      "I couldn't retrieve current stock market movers right now. Please try again in a moment."
    )
  }
}

function isSummarizeTextRequest(text: string): boolean {
  const lower = text.toLowerCase()
  if (!/\b(summarize|summarise|summary|sum up|tl;dr|tldr)\b/.test(lower)) return false
  return !/\b(plan|plans|today|daily)\b/.test(lower)
}

function isRewriteTextRequest(text: string): boolean {
  const lower = text.toLowerCase()
  return (
    /\b(rewrite|reword|paraphrase|revise|polish|clean up|improve)\b/.test(lower) ||
    /\b(make this|make it)\s+sound\b/.test(lower) ||
    /\b(grammar check|fix grammar|fix the grammar)\b/.test(lower)
  )
}

function stripWrappingQuotes(text: string): string {
  let body = text.trim()
  const quotePairs: [string, string][] = [
    ['"', '"'],
    ["'", "'"],
    ['“', '”'],
    ['‘', '’']
  ]
  for (const [open, close] of quotePairs) {
    if (body.startsWith(open) && body.endsWith(close)) {
      body = body.slice(open.length, -close.length).trim()
      break
    }
  }
  return body
}

function extractTextToRewrite(text: string): string | null {
  const trimmed = text.trim()
  const quoted =
    trimmed.match(/[“"]([\s\S]{20,})[”"]\s*$/)?.[1]?.trim() ??
    trimmed.match(/[‘']([\s\S]{20,})[’']\s*$/)?.[1]?.trim()
  if (quoted) return quoted

  const colon = trimmed.match(
    /\b(?:rewrite|reword|paraphrase|revise|polish|clean up|improve|grammar check|fix grammar|fix the grammar)\b[^:]*:\s*([\s\S]+)/i
  )
  const colonBody = colon?.[1] ? stripWrappingQuotes(colon[1]) : ''
  if (colonBody.length >= 10) return colonBody

  const body = trimmed
    .replace(/^\s*(please\s+)?(?:can you\s+|could you\s+)?(?:rewrite|reword|paraphrase|revise|polish|clean up|improve)\s*/i, '')
    .replace(/^(this|the following|this text|this paragraph|this passage)\s*/i, '')
    .trim()
  const stripped = stripWrappingQuotes(body)
  if (!stripped || /^(this|it|this text|this paragraph|the text)$/i.test(stripped)) return null
  return stripped.length >= 20 ? stripped : null
}

async function tryRewriteTextNow(
  text: string,
  userMessage: Message
): Promise<AssistantResult | null> {
  if (!isRewriteTextRequest(text)) return null

  const textToRewrite = extractTextToRewrite(text)
  if (!textToRewrite) {
    return addBasicAssistantMessage(
      userMessage,
      'Paste the text you want rewritten, like: "rewrite this: ..."'
    )
  }

  try {
    const rewritten = await rewriteText(textToRewrite, text)
    return addBasicAssistantMessage(userMessage, rewritten || 'I could not rewrite that text.')
  } catch (err) {
    db.addLog('system', `Rewrite text failed: ${(err as Error).message}`)
    return addBasicAssistantMessage(
      userMessage,
      "I couldn't rewrite that text right now. Please try again in a moment."
    )
  }
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

function extractFirstUrl(text: string): string | null {
  const match = text.match(/\bhttps?:\/\/[^\s<>"')]+/i)
  return match?.[0] ?? null
}

function stripHtmlForSummary(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<aside[\s\S]*?<\/aside>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

async function fetchArticleText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      'user-agent': 'AI Assistant desktop app'
    }
  })
  if (!res.ok) throw new Error(`Article fetch ${res.status}`)
  const contentType = res.headers.get('content-type') ?? ''
  const raw = await res.text()
  const text = contentType.includes('html') ? stripHtmlForSummary(raw) : raw.replace(/\s+/g, ' ').trim()
  if (text.length < 100) throw new Error('Article text was too short to summarize')
  return text.slice(0, 24_000)
}

async function trySummarizeTextNow(
  text: string,
  userMessage: Message
): Promise<AssistantResult | null> {
  if (!isSummarizeTextRequest(text)) return null

  const textToSummarize = extractTextToSummarize(text)
  const articleUrl = extractFirstUrl(text)
  if (!textToSummarize && !articleUrl) {
    return addBasicAssistantMessage(
      userMessage,
      'Paste the text or article URL you want summarized, like: "summarize: ..."'
    )
  }

  try {
    const input = articleUrl ? await fetchArticleText(articleUrl) : textToSummarize!
    const summary = await summarizeText(input)
    return addBasicAssistantMessage(userMessage, summary || 'I could not produce a summary.')
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'Unknown summary error'
    db.addLog('system', `Summary request failed: ${detail}`)
    return addBasicAssistantMessage(
      userMessage,
      articleUrl
        ? 'I could not retrieve and summarize that article right now. Try pasting the article text instead.'
        : 'I could not summarize that text right now. Check your model settings and try again.'
    )
  }
}

function isCallRequest(text: string): boolean {
  const lower = text.toLowerCase()
  if (isReminderRequest(text)) return false
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
    : withHelpHint(
        `This request cannot be fulfilled. AI Assistant could not start a call for ${target}. ${result.reason}`
      )
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

function parseTimeOnlyUpdate(text: string, baseIso: string): string | null {
  const time = text.match(/\b(?:to|at|for\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i)
  if (!time) return null

  const date = new Date(baseIso)
  let hour = Number(time[1])
  const minute = time[2] ? Number(time[2]) : 0
  const meridiem = time[3].toLowerCase()
  if (meridiem === 'pm' && hour < 12) hour += 12
  if (meridiem === 'am' && hour === 12) hour = 0
  date.setHours(hour, minute, 0, 0)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function cleanIntentTitleFragment(value: string): string {
  return value
    .replace(/[.!?]\s*(the|this|it)\s+[\s\S]*$/i, '')
    .replace(/[.!?]\s*(this|it)\s+(should|needs?|has to|must)\s+have\s+(a\s+)?(due\s+date|deadline)\b[\s\S]*$/i, '')
    .replace(/\bin\s+\d+\s*(second|seconds|sec|secs|minute|minutes|min|hour|hours|hr|hrs|day|days)\b/gi, '')
    .replace(/\b(?:on\s+)?\d{1,2}\/\d{1,2}\/\d{2,4}(?:\s+(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?/gi, '')
    .replace(/\btomorrow(?:\s+(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?/gi, '')
    .replace(/\b(due\s+date|deadline)\s+(is|for|on|at|of)?\b/gi, ' ')
    .replace(/\s+(as|like)\s+(a\s+)?(task|todo|to-do|reminder)\b/gi, '')
    .replace(/\s+(for me|for myself)\b/gi, '')
    .replace(/\b(as well|also|too)\b/gi, ' ')
    .replace(/^(a|an|the)\s+/i, '')
    .replace(/[?.!,]\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function titleAfterIntentKeyword(text: string, kind: 'task' | 'reminder' | 'either'): string | null {
  const target =
    kind === 'task'
      ? '(?:task|todo|to-do)'
      : kind === 'reminder'
        ? 'reminder'
        : '(?:task|todo|to-do|reminder)(?:\\s+and\\s+(?:task|todo|to-do|reminder))?'
  const patterns = [
    new RegExp(`\\b${target}\\s+(?:for\\s+me\\s+)?(?:to|for|about|called|named)\\s+([\\s\\S]+)$`, 'i'),
    new RegExp(`\\b(?:set|create|add|make)\\s+(?:a\\s+)?(?:new\\s+)?${target}\\s+(?:for\\s+me\\s+)?(?:to|for|about|called|named)\\s+([\\s\\S]+)$`, 'i')
  ]

  if (kind === 'reminder' || kind === 'either') {
    patterns.unshift(/\bremind\s+me\s+(?:to|for|about)\s+([\s\S]+)$/i)
  }

  for (const pattern of patterns) {
    const match = text.match(pattern)
    const title = match?.[1] ? cleanIntentTitleFragment(match[1]) : ''
    if (title) return title
  }

  return null
}

function cleanTaskTitle(text: string): string {
  let title = titleAfterIntentKeyword(text, 'task') ?? titleAfterIntentKeyword(text, 'either') ?? text
    .replace(/^\s*(hi|hey|hello)[,!]?\s+/i, '')
    .replace(/^(can you|could you|please|for me)\s+/i, '')
    .replace(/[.!?]\s*(this|it)\s+(should|needs?|has to|must)\s+have\s+(a\s+)?(due\s+date|deadline)\b[\s\S]*$/i, '')
    .replace(/\bin\s+\d+\s*(minute|minutes|min|hour|hours|hr|hrs|day|days)\b/gi, '')
    .replace(/\b(?:on\s+)?\d{1,2}\/\d{1,2}\/\d{2,4}(?:\s+(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?/gi, '')
    .replace(/\btomorrow(?:\s+(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?/gi, '')
    .replace(/\b(task|todo|to-do)\s+and\s+reminder\s+(to|for|about)\b/gi, '$2')
    .replace(/\breminder\s+and\s+(task|todo|to-do)\s+(to|for|about)\b/gi, '$2')
    .replace(/\b(task|todo|to-do)\s+and\s+reminder\b/gi, ' ')
    .replace(/\breminder\s+and\s+(task|todo|to-do)\b/gi, ' ')
    .replace(/^(please\s+)?(set|create|add|make)\s+(a\s+)?(new\s+)?(task|todo|to-do)\s*/i, '')
    .replace(/^(please\s+)?(set|create|add|make)\s+(a\s+)?(new\s+)?(task|todo|to-do)\s+(to|for|called|named)\s*/i, '')
    .replace(/^(please\s+)?schedule\s+(a\s+)?/i, '')
    .replace(/\b(due\s+date|deadline)\s+(is|for|on|at|of)?\b/gi, ' ')
    .replace(/\b(and|as well)\b/gi, ' ')
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
    /\b(set|create|add|make)\s+(a\s+)?(new\s+)?(task|todo|to-do)\b/.test(lower) ||
    /\bschedule\b/.test(lower)
  )
}

function isFollowUpEmailTaskRequest(text: string): boolean {
  return (
    /\b(add|create|make|set)\b[\s\S]*\b(this|that|it|action|email|draft)\b[\s\S]*\b(task|todo|to-do)\b/i.test(
      text
    ) ||
    /\b(add|create|make|set)\b[\s\S]*\b(task|todo|to-do)\b[\s\S]*\b(for|from)\b[\s\S]*\b(this|that|email|draft)\b/i.test(
      text
    )
  )
}

function latestEmailDraftMessage(): Message | null {
  const messages = db.listMessages(30)
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message.role === 'assistant' && message.intent === 'generate_email') return message
  }
  return null
}

function emailTaskTitleFromDraft(content: string): string {
  const to = content.match(/^\s*To:\s*(.+)$/im)?.[1]?.trim()
  if (to) return `Send email to ${to}`

  const bodyStart = content.match(/(?:^|\n)Draft email:\s*/i)
  const rawBody = bodyStart ? content.slice((bodyStart.index ?? 0) + bodyStart[0].length) : content
  const body = rawBody
    .split('\n')
    .filter((line) => !/^\s*(To|Subject):\s*/i.test(line))
    .join('\n')
    .trim()
  const greeting = body.match(/^\s*(?:hi|hey|dear|hello)\s+([^,\n.!?]+)/i)?.[1]?.trim()
  if (greeting && !/^(there|everyone|all)$/i.test(greeting)) {
    return `Send email to ${greeting}`
  }

  const subject = content.match(/^\s*Subject:\s*(.+)$/im)?.[1]?.trim()
  if (subject) return `Send email: ${subject}`
  return 'Send last email draft'
}

function tryCreateFollowUpEmailTaskNow(text: string, userMessage: Message): AssistantResult | null {
  if (!isFollowUpEmailTaskRequest(text)) return null

  const draftMessage = latestEmailDraftMessage()
  if (!draftMessage) return null

  const title = emailTaskTitleFromDraft(draftMessage.content)
  const due = parseDateFromTaskText(text)
  db.addTask(title, due)
  syncTaskToMacCalendar(title, due)
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

function tryCreateTaskNow(text: string, userMessage: Message): AssistantResult | null {
  if (!isTaskRequest(text)) return null
  const title = cleanTaskTitle(text)
  if (!title || /^(it|this|that)(\s+as\s+(a\s+)?task)?$/i.test(title)) return null

  const due = parseDateFromTaskText(text)
  db.addTask(title, due)
  syncTaskToMacCalendar(title, due)
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

function isTaskAndReminderRequest(text: string): boolean {
  const lower = text.toLowerCase()
  return (
    /\b(task|todo|to-do)\b/.test(lower) &&
    /\breminder\b/.test(lower) &&
    /\b(create|add|make|schedule|set)\b/.test(lower)
  )
}

function tryCreateTaskAndReminderNow(text: string, userMessage: Message): AssistantResult | null {
  if (!isTaskAndReminderRequest(text)) return null

  const datetime = parseDateFromTaskText(text)
  if (!datetime) {
    const assistantMessage = db.addMessage(
      'assistant',
      'When should I schedule the task and reminder?',
      'create_reminder'
    )
    return {
      userMessage,
      assistantMessage,
      intent: 'create_reminder'
    }
  }

  const title = cleanTaskTitle(text)
  if (!title || /^(it|this|that)$/i.test(title)) return null

  db.addTask(title, datetime)
  db.addReminder(title, datetime, 'none')
  syncTaskToMacCalendar(title, datetime)
  syncReminderToMac(title, datetime)
  const when = formatReminderTime(datetime)
  const assistantMessage = db.addMessage(
    'assistant',
    `Created task and reminder: ${title}. It is scheduled for ${when}.`,
    'create_reminder'
  )
  return {
    userMessage,
    assistantMessage,
    intent: 'create_reminder'
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

function findTaskToDelete(
  title: string | null
): { id: number; title: string; due: string | null } | null {
  if (!title) return null
  const tasks = db.listTasks()
  const normalizedTitle = title.toLowerCase()
  const exact = tasks.find((t) => t.title.toLowerCase() === normalizedTitle)
  if (exact) return { id: exact.id, title: exact.title, due: exact.due }

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
  return best ? { id: best.id, title: best.title, due: best.due } : null
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
  removeTaskFromMacCalendar(task.title, task.due)
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

function isScheduleUpdateRequest(text: string): boolean {
  if (isTaskRequest(text) || isTaskAndReminderRequest(text) || isReminderRequest(text)) {
    return false
  }
  return /\b(wait|actually|change|update|move|reschedule|set|edit)\b/i.test(text) &&
    /\b(to|at|for|tomorrow|in\s+\d+|\d{1,2}(?::\d{2})?\s*(am|pm))\b/i.test(text)
}

function scheduleUpdateKind(text: string): 'reminder' | 'task' | null {
  if (/\breminder\b/i.test(text)) return 'reminder'
  if (/\b(task|todo|to-do)\b/i.test(text)) return 'task'
  return null
}

function cleanScheduleUpdateTitle(text: string): string | null {
  const explicit = text.match(/\b(?:reminder|task|todo|to-do)\s+(?:to|for|about|called|named)\s+([\s\S]+?)(?:\s+(?:and\s+)?(?:set|change|update|move|reschedule)\b|\s+\b(?:to|at)\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|$)/i)
  let title = explicit?.[1]?.trim()

  if (!title) {
    const generic = text.match(/\b(?:edit|change|update|move|reschedule)\s+([\s\S]+?)(?:\s+(?:and\s+)?(?:set|change|update|move|reschedule)\b|\s+\b(?:to|at)\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|$)/i)
    title = generic?.[1]?.trim()
  }

  if (!title) return null
  title = title
    .replace(/\b(the|a|an|reminder|task|todo|to-do)\b/gi, ' ')
    .replace(/\bin\s+\d+\s*(second|seconds|sec|secs|minute|minutes|min|hour|hours|hr|hrs|day|days)\b/gi, ' ')
    .replace(/\b(?:on\s+)?\d{1,2}\/\d{1,2}\/\d{2,4}(?:\s+(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?/gi, ' ')
    .replace(/\btomorrow(?:\s+(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?/gi, ' ')
    .replace(/\b(and|then)$/i, ' ')
    .replace(/[?.!,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return title || null
}

function lastCreatedTaskTitle(userMessage: Message): string | null {
  const matches = db
    .listMessages(12)
    .filter((m) => m.id < userMessage.id && m.role === 'assistant' && m.intent === 'create_task')
    .map((m) => m.content.match(/^Created task: (.+?)(?:\. It is due |\.?$)/i)?.[1]?.trim())
    .filter((title): title is string => !!title)

  return matches.at(-1) ?? null
}

function findTaskByTitle(title: string | null): { id: number; title: string; due: string | null } | null {
  if (!title) return null
  const tasks = db.listTasks()
  const normalizedTitle = title.toLowerCase()
  const exact = tasks.find((t) => t.title.toLowerCase() === normalizedTitle)
  if (exact) return { id: exact.id, title: exact.title, due: exact.due }

  const titleWords = normalizedWords(title)
  if (titleWords.length === 0) return null
  const scored = tasks
    .map((task) => {
      const taskWords = normalizedWords(task.title)
      return {
        task,
        score: titleWords.filter((word) => taskWords.includes(word)).length
      }
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)

  if (scored.length > 1 && scored[0].score === scored[1].score) return null
  const best = scored[0]?.task
  return best ? { id: best.id, title: best.title, due: best.due } : null
}

function lastEditedScheduleTarget(
  userMessage: Message
): { kind: 'reminder'; id: number; title: string; datetime: string } | { kind: 'task'; id: number; title: string; due: string | null } | null {
  const recentAssistant = db
    .listMessages(12)
    .filter(
      (m) =>
        m.id < userMessage.id &&
        m.role === 'assistant' &&
        (m.intent === 'create_reminder' || m.intent === 'create_task')
    )
    .at(-1)

  if (!recentAssistant) return null

  if (recentAssistant.intent === 'create_reminder') {
    const title = lastCreatedReminderTitle(userMessage)
    const reminder = findActiveReminder(title)
    if (reminder) {
      const current = db.listReminders().find((r) => r.id === reminder.id)
      if (current) {
        return {
          kind: 'reminder',
          id: current.id,
          title: current.title,
          datetime: current.datetime
        }
      }
    }
  }

  const task = findTaskByTitle(lastCreatedTaskTitle(userMessage))
  return task ? { kind: 'task', ...task } : null
}

function namedScheduleTarget(
  text: string
): { kind: 'reminder'; id: number; title: string; datetime: string } | { kind: 'task'; id: number; title: string; due: string | null } | null {
  const title = cleanScheduleUpdateTitle(text)
  if (!title) return null

  const kind = scheduleUpdateKind(text)
  if (kind !== 'task') {
    const reminder = findActiveReminder(title)
    if (reminder) {
      const current = db.listReminders().find((r) => r.id === reminder.id)
      if (current) {
        return {
          kind: 'reminder',
          id: current.id,
          title: current.title,
          datetime: current.datetime
        }
      }
    }
  }

  if (kind !== 'reminder') {
    const task = findTaskByTitle(title)
    if (task) return { kind: 'task', ...task }
  }

  return null
}

function tryUpdateLastScheduleNow(text: string, userMessage: Message): AssistantResult | null {
  if (!isScheduleUpdateRequest(text)) return null

  const target = namedScheduleTarget(text) ?? lastEditedScheduleTarget(userMessage)
  if (!target) return null

  const base = target.kind === 'reminder' ? target.datetime : target.due ?? new Date().toISOString()
  const updatedDate = parseDateFromTaskText(text) ?? parseTimeOnlyUpdate(text, base)
  if (!updatedDate) return null

  if (target.kind === 'reminder') {
    removeReminderFromMac(target.title, target.datetime)
    db.rescheduleReminder(target.id, updatedDate)
    syncReminderToMac(target.title, updatedDate)
    const assistantMessage = db.addMessage(
      'assistant',
      `Updated reminder: ${target.title}. I’ll remind you ${formatReminderTime(updatedDate)}.`,
      'create_reminder'
    )
    return {
      userMessage,
      assistantMessage,
      intent: 'create_reminder'
    }
  }

  removeTaskFromMacCalendar(target.title, target.due)
  db.updateTaskDue(target.id, updatedDate)
  syncTaskToMacCalendar(target.title, updatedDate)
  const assistantMessage = db.addMessage(
    'assistant',
    `Updated task: ${target.title}. It is due ${formatReminderTime(updatedDate)}.`,
    'create_task'
  )
  return {
    userMessage,
    assistantMessage,
    intent: 'create_task'
  }
}

function cleanReminderTitle(text: string): string {
  return (titleAfterIntentKeyword(text, 'reminder') ?? titleAfterIntentKeyword(text, 'either') ?? text)
    .replace(/^\s*(hi|hey|hello)[,!]?\s+/i, '')
    .replace(/^\s*(can you|could you|please)\s+/i, '')
    .replace(/[.!?]\s*(the|this|it)\s+[\s\S]*$/i, '')
    .replace(/\bin\s+\d+\s*(second|seconds|sec|secs|minute|minutes|min|hour|hours|hr|hrs|day|days)\b/gi, '')
    .replace(/\b(?:on\s+)?\d{1,2}\/\d{1,2}\/\d{2,4}(?:\s+(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?/gi, '')
    .replace(/\btomorrow(?:\s+(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?/gi, '')
    .replace(/^(please\s+)?(set|create|add|make)\s+(a\s+)?(new\s+)?reminder\s*/i, '')
    .replace(/^remind\s+me\s*/i, '')
    .replace(/^(for me\s+)?(to|for|about)\s+/i, '')
    .replace(/^me\s+to\s+/i, '')
    .replace(/^(a|an|the)\s+/i, '')
    .replace(/\b(as well|also|too)\b/gi, ' ')
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

function pendingReminderTitleFromLastTask(userMessage: Message): string | null {
  const previousAssistant = db
    .listMessages(8)
    .filter(
      (m) =>
        m.id < userMessage.id &&
        m.role === 'assistant' &&
        m.intent === 'create_reminder' &&
        /^When should I remind you about (?:as well|also|too)\?$/i.test(m.content)
    )
    .at(-1)

  if (!previousAssistant) return null
  return lastCreatedTaskTitle(userMessage)
}

function tryCompletePendingReminder(text: string, userMessage: Message): AssistantResult | null {
  if (isReminderRequest(text)) return null

  const title = pendingReminderTitle(userMessage) ?? pendingReminderTitleFromLastTask(userMessage)
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
  syncReminderToMac(title, datetime)
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

function findActiveReminder(
  title: string | null
): { id: number; title: string; datetime: string } | null {
  const reminders = db.listReminders()
  if (!title) return null

  const normalizedTitle = title.toLowerCase()
  const exact = reminders.find((r) => r.title.toLowerCase() === normalizedTitle)
  if (exact) return { id: exact.id, title: exact.title, datetime: exact.datetime }

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
  return best ? { id: best.id, title: best.title, datetime: best.datetime } : null
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
  removeReminderFromMac(reminder.title, reminder.datetime)
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
  if (!hasPendingReminderRemoval(userMessage)) return null
  if (isReminderRequest(text) || isTaskRequest(text)) return null

  const typedTitle = cleanReminderRemovalTitle(text)
  const title = typedTitle || previousReminderRemovalTitle(userMessage) || lastCreatedReminderTitle(userMessage)
  if (!title) return null

  return removeReminderByTitle(title || null, userMessage)
}

function isBulkTaskReminderClearRequest(text: string): boolean {
  const lower = text.toLowerCase()
  if (!/\b(remove|delete|clear|dismiss|cancel)\b/.test(lower)) return false
  if (!/\b(all|everything|every)\b/.test(lower)) return false
  return /\b(tasks?|todos?|to-dos?|reminders?)\b/.test(lower)
}

function tryClearTasksAndRemindersNow(
  text: string,
  userMessage: Message
): AssistantResult | null {
  if (!isBulkTaskReminderClearRequest(text)) return null

  const lower = text.toLowerCase()
  const shouldClearTasks = /\b(tasks?|todos?|to-dos?)\b/.test(lower)
  const shouldClearReminders = /\breminders?\b/.test(lower)
  const tasks = shouldClearTasks ? db.listTasks() : []
  const reminders = shouldClearReminders ? db.listReminders() : []

  for (const task of tasks) {
    db.deleteTask(task.id)
    removeTaskFromMacCalendar(task.title, task.due)
  }
  for (const reminder of reminders) {
    db.dismissReminder(reminder.id)
    removeReminderFromMac(reminder.title, reminder.datetime)
  }

  const parts: string[] = []
  if (shouldClearTasks) parts.push(`${tasks.length} task${tasks.length === 1 ? '' : 's'}`)
  if (shouldClearReminders)
    parts.push(`${reminders.length} reminder${reminders.length === 1 ? '' : 's'}`)

  const assistantMessage = db.addMessage(
    'assistant',
    parts.length
      ? `Removed ${parts.join(' and ')}.`
      : 'There was nothing to remove.',
    shouldClearReminders ? 'create_reminder' : 'create_task'
  )
  return {
    userMessage,
    assistantMessage,
    intent: shouldClearReminders ? 'create_reminder' : 'create_task'
  }
}

function tryCreateReminderNow(text: string, userMessage: Message): AssistantResult | null {
  if (!isReminderRequest(text)) return null
  const datetime = parseDateFromTaskText(text)
  let title = cleanReminderTitle(text)
  if (/^(it|this|that)$/i.test(title)) title = ''
  if (/\b(as well|also|too)\b/i.test(text) && !title) {
    title = lastCreatedTaskTitle(userMessage) ?? ''
  }

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
  syncReminderToMac(title, datetime)
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
  if (isReminderRequest(text)) return null
  if (!hasImmediateOpenIntent(text)) return null

  const label = resolveApp(text)
  if (!label) {
    const message = withHelpHint(
      'This request cannot be fulfilled. AI Assistant can currently open only these apps: ' +
        `${allowlistLabels().join(', ')}.`
    )
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
    : withHelpHint(
        `This request cannot be fulfilled. AI Assistant could not open ${label}. ${result.reason}`
      )
  const assistantMessage = db.addMessage('assistant', message, 'schedule_app_open')
  if (!result.ok) db.addLog('system', `Immediate app open failed: ${label}: ${result.reason}`)
  return {
    userMessage,
    assistantMessage,
    intent: 'schedule_app_open'
  }
}

function tryCloseAppNow(text: string, userMessage: Message): AssistantResult | null {
  if (isReminderRequest(text)) return null
  const lower = text.toLowerCase()
  if (!/\b(close|quit|exit|shut)\b/.test(lower)) return null

  const label = resolveApp(text)
  if (!label) {
    const message = withHelpHint(
      'This request cannot be fulfilled. AI Assistant can currently close only these apps: ' +
        `${allowlistLabels().join(', ')}.`
    )
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
    : withHelpHint(
        `This request cannot be fulfilled. AI Assistant could not close ${label}. ${result.reason}`
      )
  const assistantMessage = db.addMessage('assistant', message, 'schedule_app_open')
  if (!result.ok) db.addLog('system', `Immediate app close failed: ${label}: ${result.reason}`)
  return {
    userMessage,
    assistantMessage,
    intent: 'schedule_app_open'
  }
}

function tryBrowserSiteOpen(text: string, userMessage: Message): AssistantResult | null {
  if (isReminderRequest(text)) return null
  if (!hasBrowserSiteIntent(text)) return null

  const result = openKnownSite(text)
  const message = result.ok
    ? `Opening ${result.site} in ${result.browser}.`
    : withHelpHint(`This request cannot be fulfilled. ${result.reason}`)
  const assistantMessage = db.addMessage('assistant', message, 'schedule_app_open')
  if (!result.ok) db.addLog('system', `Browser action failed: ${result.reason}`)
  return {
    userMessage,
    assistantMessage,
    intent: 'schedule_app_open'
  }
}

function tryBrowserSiteClose(text: string, userMessage: Message): AssistantResult | null {
  if (isReminderRequest(text)) return null
  if (!hasBrowserSiteCloseIntent(text)) return null

  const result = closeKnownSite(text)
  const message = result.ok
    ? `Closed ${result.site} in ${result.browser}.`
    : withHelpHint(`This request cannot be fulfilled. ${result.reason}`)
  const assistantMessage = db.addMessage('assistant', message, 'schedule_app_open')
  if (!result.ok) db.addLog('system', `Browser close action failed: ${result.reason}`)
  return {
    userMessage,
    assistantMessage,
    intent: 'schedule_app_open'
  }
}

function tryScheduleBrowserSiteAction(text: string, userMessage: Message): AssistantResult | null {
  if (isReminderRequest(text)) return null
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
  if (isReminderRequest(text)) return null
  const lower = text.toLowerCase()
  if (!/\b(open|launch|start)\b/.test(lower)) return null

  const datetime = parseRelativeDate(text)
  if (!datetime) return null

  const label = resolveApp(text)
  if (!label) {
    const message = withHelpHint(
      'This request cannot be fulfilled. AI Assistant can currently schedule only these apps: ' +
        `${allowlistLabels().join(', ')}.`
    )
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
  ipcMain.handle('window:getExpandedBounds', () => {
    if (win && expanded) return win.getBounds()
    const size = expandedWindowSize()
    const position = positionFor(size)
    return { ...position, ...size }
  })
  ipcMain.handle('window:resizeExpandedBounds', (_e, bounds: unknown) => {
    const value = bounds as {
      x?: unknown
      y?: unknown
      width?: unknown
      height?: unknown
    }
    if (
      typeof value?.x !== 'number' ||
      typeof value?.y !== 'number' ||
      typeof value?.width !== 'number' ||
      typeof value?.height !== 'number'
    ) {
      return null
    }
    return resizeExpandedBounds({
      x: value.x,
      y: value.y,
      width: value.width,
      height: value.height
    })
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
  ipcMain.handle('tasks:toggle', (_e, id: unknown) => {
    if (typeof id !== 'number') return null
    const before = db.listTasks().find((task) => task.id === id) ?? null
    const after = db.toggleTask(id)
    if (before && after) {
      if (after.done) removeTaskFromMacCalendar(before.title, before.due)
      else syncTaskToMacCalendar(after.title, after.due)
    }
    return after
  })
  ipcMain.handle('tasks:updateDue', (_e, id: unknown, due: unknown) => {
    if (typeof id !== 'number') return null
    if (due !== null && typeof due !== 'string') return null
    if (typeof due === 'string' && Number.isNaN(Date.parse(due))) return null
    const before = db.listTasks().find((task) => task.id === id) ?? null
    const after = db.updateTaskDue(id, due)
    if (before) removeTaskFromMacCalendar(before.title, before.due)
    if (after && !after.done) syncTaskToMacCalendar(after.title, after.due)
    return after
  })
  ipcMain.handle('tasks:delete', (_e, id: unknown) => {
    if (typeof id === 'number') {
      const task = db.listTasks().find((item) => item.id === id) ?? null
      db.deleteTask(id)
      if (task) removeTaskFromMacCalendar(task.title, task.due)
    }
    return true
  })

  ipcMain.handle('reminders:list', () => db.listReminders())
  ipcMain.handle('reminders:dismiss', (_e, id: unknown) => {
    if (typeof id === 'number') {
      const reminder = db.listReminders().find((item) => item.id === id) ?? null
      db.dismissReminder(id)
      if (reminder) removeReminderFromMac(reminder.title, reminder.datetime)
    }
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
    const sample = db.addWritingSample(content.trim())
    db.clearWritingProfile()
    return sample
  })
  ipcMain.handle('writing:listSamples', () => db.listWritingSamples())
  ipcMain.handle('writing:deleteSample', (_e, id: unknown) => {
    if (typeof id === 'number') {
      db.deleteWritingSample(id)
      db.clearWritingProfile()
    }
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

    const helpResult = tryHelpCommand(text.trim(), userMessage)
    if (helpResult) {
      emit({ type: 'data-changed' })
      return helpResult
    }

    const timeZoneConversionResult = tryConvertTimeZone(text.trim(), userMessage)
    if (timeZoneConversionResult) {
      emit({ type: 'data-changed' })
      return timeZoneConversionResult
    }

    const timeResult = tryTellTimeNow(text.trim(), userMessage)
    if (timeResult) {
      emit({ type: 'data-changed' })
      return timeResult
    }

    const weatherEmailResult = await tryWeatherEmailDraftNow(text.trim(), userMessage)
    if (weatherEmailResult) {
      emit({ type: 'data-changed' })
      return weatherEmailResult
    }

    const weatherResult = await tryWeatherNow(text.trim(), userMessage)
    if (weatherResult) {
      emit({ type: 'data-changed' })
      return weatherResult
    }

    const stockQuoteResult = await tryStockQuoteNow(text.trim(), userMessage)
    if (stockQuoteResult) {
      emit({ type: 'data-changed' })
      return stockQuoteResult
    }

    const marketMoversResult = await tryMarketMoversNow(text.trim(), userMessage)
    if (marketMoversResult) {
      emit({ type: 'data-changed' })
      return marketMoversResult
    }

    const rewriteResult = await tryRewriteTextNow(text.trim(), userMessage)
    if (rewriteResult) {
      emit({ type: 'data-changed' })
      return rewriteResult
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

    const clearTasksRemindersResult = tryClearTasksAndRemindersNow(text.trim(), userMessage)
    if (clearTasksRemindersResult) {
      emit({ type: 'data-changed' })
      return clearTasksRemindersResult
    }

    const followUpEmailTaskResult = tryCreateFollowUpEmailTaskNow(text.trim(), userMessage)
    if (followUpEmailTaskResult) {
      emit({ type: 'data-changed' })
      return followUpEmailTaskResult
    }

    const removeReminderResult = tryRemoveReminderNow(text.trim(), userMessage)
    if (removeReminderResult) {
      emit({ type: 'data-changed' })
      return removeReminderResult
    }

    const pendingReminderResult = tryCompletePendingReminder(text.trim(), userMessage)
    if (pendingReminderResult) {
      emit({ type: 'data-changed' })
      return pendingReminderResult
    }

    const combinedTaskReminderResult = tryCreateTaskAndReminderNow(text.trim(), userMessage)
    if (combinedTaskReminderResult) {
      emit({ type: 'data-changed' })
      return combinedTaskReminderResult
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

    const updateScheduleResult = tryUpdateLastScheduleNow(text.trim(), userMessage)
    if (updateScheduleResult) {
      emit({ type: 'data-changed' })
      return updateScheduleResult
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

    let res: Awaited<ReturnType<typeof runAssistant>>
    try {
      res = await runAssistant(text.trim())
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'Unknown assistant error'
      db.addLog('system', `Assistant request failed: ${detail}`)
      try {
        const fallback = await runGeneralChat(text.trim())
        if (fallback) {
          const assistantMessage = db.addMessage('assistant', fallback, 'general_chat')
          emit({ type: 'data-changed' })
          return {
            userMessage,
            assistantMessage,
            intent: 'general_chat'
          }
        }
      } catch (fallbackErr) {
        const fallbackDetail =
          fallbackErr instanceof Error ? fallbackErr.message : 'Unknown fallback error'
        db.addLog('system', `General chat fallback failed: ${fallbackDetail}`)
      }
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

    for (const t of tasksToCreate) {
      const due = t.due ?? null
      db.addTask(t.title, due)
      syncTaskToMacCalendar(t.title, due)
    }
    for (const r of remindersToCreate) {
      db.addReminder(r.title, r.datetime, r.recurrence)
      syncReminderToMac(r.title, r.datetime)
    }

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
