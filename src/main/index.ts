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
  summarizeText,
  summarizeWritingProfile,
  transcribeAudio,
  AssistantError
} from './assistant'
import { startScheduler, stopScheduler, executeAction } from './scheduler'
import { createMacCalendarEventForTask, createMacReminder } from './macNative'

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
      '- Summarize: `summarize: paste text here` or `summarize this article: https://...`',
      '- Live info: `weather in NYC`, `current market movers`, `top stock gainers`',
      '- Time: `what time is it in London?` or `convert 5pm PST to EST`',
      '- Tasks: `create a task to call Derek tomorrow at 2pm`',
      '- Reminders: `remind me in 1 hour to leave work`',
      '- Edit/delete: `move that reminder to 10pm`, `delete the meeting task`, `remove all tasks and reminders`',
      '- Apps/sites: `open Slack`, `open Gmail in Chrome`, `close Gmail in Chrome`, `open Chrome in 10 minutes`',
      '- Writing: `write an email to Rose about the referral inquiry`',
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

function tryConvertTimeZone(text: string, userMessage: Message): AssistantResult | null {
  const match = text.match(
    /\b(?:convert|what(?:'s| is)|change)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s+([a-z]{2,4})\s+(?:to|in|into)\s+([a-z]{2,4})\b/i
  )
  if (!match) return null

  const source = parseFixedTimeZone(match[4])
  const target = parseFixedTimeZone(match[5])
  if (!source || !target) return null

  let hour = Number(match[1])
  const minute = match[2] ? Number(match[2]) : 0
  const meridiem = match[3].toLowerCase()
  if (hour < 1 || hour > 12 || minute < 0 || minute > 59) return null
  if (meridiem === 'pm' && hour < 12) hour += 12
  if (meridiem === 'am' && hour === 12) hour = 0

  const sourceMinutes = hour * 60 + minute
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

type YahooScreenerId = 'day_gainers' | 'day_losers' | 'most_actives'

interface MarketMover {
  symbol: string
  name: string
  price: number | null
  change: number | null
  changePercent: number | null
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

function cleanTaskTitle(text: string): string {
  let title = text
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
    db.rescheduleReminder(target.id, updatedDate)
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

  db.updateTaskDue(target.id, updatedDate)
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
  return text
    .replace(/^\s*(hi|hey|hello)[,!]?\s+/i, '')
    .replace(/\bin\s+\d+\s*(second|seconds|sec|secs|minute|minutes|min|hour|hours|hr|hrs|day|days)\b/gi, '')
    .replace(/\b(?:on\s+)?\d{1,2}\/\d{1,2}\/\d{2,4}(?:\s+(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?/gi, '')
    .replace(/\btomorrow(?:\s+(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?/gi, '')
    .replace(/^(please\s+)?(set|create|add|make)\s+(a\s+)?(new\s+)?reminder\s*/i, '')
    .replace(/^remind\s+me\s*/i, '')
    .replace(/^(to|for|about)\s+/i, '')
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

  for (const task of tasks) db.deleteTask(task.id)
  for (const reminder of reminders) db.dismissReminder(reminder.id)

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

    const weatherResult = await tryWeatherNow(text.trim(), userMessage)
    if (weatherResult) {
      emit({ type: 'data-changed' })
      return weatherResult
    }

    const marketMoversResult = await tryMarketMoversNow(text.trim(), userMessage)
    if (marketMoversResult) {
      emit({ type: 'data-changed' })
      return marketMoversResult
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
