import { spawnSync } from 'node:child_process'

type BrowserName = 'chrome' | 'safari'
type BrowserSiteActionKind = 'open' | 'close'

interface KnownSite {
  label: string
  url: string
  aliases: string[]
}

export interface ResolvedSite {
  label: string
  url: string
}

export interface BrowserSiteAction {
  kind: BrowserSiteActionKind
  browser: string
  site: string
  url: string
}

const BROWSERS: Record<BrowserName, string> = {
  chrome: 'Google Chrome',
  safari: 'Safari'
}

const KNOWN_SITES: KnownSite[] = [
  {
    label: 'Gmail',
    url: 'https://mail.google.com',
    aliases: ['gmail', 'gnail', 'google mail', 'mail.google.com']
  },
  {
    label: 'Google Calendar',
    url: 'https://calendar.google.com',
    aliases: ['google calendar', 'calendar.google', 'gcal']
  },
  {
    label: 'Google Drive',
    url: 'https://drive.google.com',
    aliases: ['google drive', 'drive']
  },
  {
    label: 'Google Docs',
    url: 'https://docs.google.com',
    aliases: ['google docs', 'docs']
  },
  {
    label: 'YouTube',
    url: 'https://www.youtube.com',
    aliases: ['youtube', 'you tube']
  },
  {
    label: 'LinkedIn',
    url: 'https://www.linkedin.com',
    aliases: ['linkedin', 'linked in']
  },
  {
    label: 'ChatGPT',
    url: 'https://chatgpt.com',
    aliases: ['chatgpt', 'chat gpt']
  },
  {
    label: 'Claude',
    url: 'https://claude.ai',
    aliases: ['claude', 'claude ai', 'anthropic claude']
  },
  {
    label: 'Google',
    url: 'https://www.google.com',
    aliases: ['google search']
  }
]

const BROWSER_ACTION_NOTE_PREFIX = 'browser-action:'

export type BrowserControlResult =
  | { ok: true; browser: string; site: string; url: string }
  | { ok: false; reason: string }

export function resolveBrowser(text: string): BrowserName {
  const lower = text.toLowerCase()
  if (/\bsafari\b/.test(lower)) return 'safari'
  if (/\b(google|chrome|google chrome)\b/.test(lower)) return 'chrome'
  return 'chrome'
}

export function browserLabelForText(text: string): string {
  return BROWSERS[resolveBrowser(text)]
}

export function resolveKnownSite(text: string): KnownSite | null {
  const lower = text.toLowerCase()
  return (
    KNOWN_SITES.find((site) =>
      site.aliases.some((alias) => new RegExp(`\\b${escapeRegex(alias)}\\b`, 'i').test(lower))
    ) ?? null
  )
}

export function resolveSite(text: string): ResolvedSite | null {
  const known = resolveKnownSite(text)
  if (known) return known

  const lower = text.toLowerCase()
  if (!/\b(open|launch|start|go to|navigate to)\b/.test(lower)) return null

  const url = lower.match(/\bhttps?:\/\/[^\s]+|\b[a-z0-9-]+\.(com|ai|io|net|org|dev)\b/i)?.[0]
  if (url) {
    const normalizedUrl = url.startsWith('http') ? url : `https://${url}`
    return { label: stripUrlLabel(url), url: normalizedUrl }
  }

  if (!hasBrowserContext(text)) return null

  const target = extractSiteTarget(text)
  if (!target) return null
  return {
    label: titleCase(target),
    url: `https://www.${target.toLowerCase()}.com`
  }
}

export function resolveSiteForClose(text: string): ResolvedSite | null {
  const known = resolveKnownSite(text)
  if (known) return known

  const url = text.match(/\bhttps?:\/\/[^\s]+|\b[a-z0-9-]+\.(com|ai|io|net|org|dev)\b/i)?.[0]
  if (url) {
    const normalizedUrl = url.startsWith('http') ? url : `https://${url}`
    return { label: stripUrlLabel(url), url: normalizedUrl }
  }

  if (!hasBrowserContext(text)) return null

  const target = extractSiteTarget(text)
  if (!target) return null
  return {
    label: titleCase(target),
    url: `https://www.${target.toLowerCase()}.com`
  }
}

export function hasBrowserSiteIntent(text: string): boolean {
  const lower = text.toLowerCase()
  const hasOpenVerb = /\b(open|launch|start|go to|navigate to)\b/.test(lower)
  return hasOpenVerb && !!resolveSite(text)
}

export function hasBrowserSiteCloseIntent(text: string): boolean {
  const lower = text.toLowerCase()
  const hasCloseVerb = /\b(close|quit|exit|shut)\b/.test(lower)
  return hasCloseVerb && !!resolveSiteForClose(text)
}

export function openKnownSite(
  text: string,
  browser: BrowserName = resolveBrowser(text)
): BrowserControlResult {
  const site = resolveSite(text)
  if (!site) {
    return {
      ok: false,
      reason:
        'AI Assistant can currently open only known sites such as Gmail, Claude, Google Calendar, Drive, Docs, YouTube, ChatGPT, and Google Search.'
    }
  }

  const appName = BROWSERS[browser]
  const result = spawnSync('open', ['-a', appName, site.url], { encoding: 'utf8' })
  if (result.error) return { ok: false, reason: result.error.message }
  if (result.status !== 0) {
    return {
      ok: false,
      reason: (result.stderr || result.stdout || `exit code ${result.status}`).trim()
    }
  }

  return { ok: true, browser: appName, site: site.label, url: site.url }
}

export function closeKnownSite(
  text: string,
  browser: BrowserName = resolveBrowser(text)
): BrowserControlResult {
  const site = resolveSiteForClose(text)
  if (!site) {
    return {
      ok: false,
      reason:
        'AI Assistant could not identify which browser tab to close. Try naming the site, like "close Gmail in Chrome".'
    }
  }

  const appName = BROWSERS[browser]
  const host = hostnameFor(site.url)
  const script =
    browser === 'safari'
      ? safariCloseScript(appName, site, host)
      : chromeCloseScript(appName, site, host)
  const result = spawnSync('osascript', ['-e', script], { encoding: 'utf8' })
  if (result.error) return { ok: false, reason: result.error.message }
  if (result.status !== 0) {
    return {
      ok: false,
      reason: (result.stderr || result.stdout || `exit code ${result.status}`).trim()
    }
  }

  const closedCount = Number.parseInt(result.stdout.trim(), 10)
  if (!Number.isFinite(closedCount) || closedCount < 1) {
    return {
      ok: false,
      reason: `No matching ${site.label} tab was found in ${appName}.`
    }
  }

  return { ok: true, browser: appName, site: site.label, url: site.url }
}

export function browserSiteActionFromText(
  text: string,
  kind: BrowserSiteActionKind
): BrowserSiteAction | null {
  const site = kind === 'close' ? resolveSiteForClose(text) : resolveSite(text)
  if (!site) return null
  return {
    kind,
    browser: browserLabelForText(text),
    site: site.label,
    url: site.url
  }
}

export function encodeBrowserActionNote(action: BrowserSiteAction): string {
  return `${BROWSER_ACTION_NOTE_PREFIX}${JSON.stringify(action)}`
}

export function decodeBrowserActionNote(note: string | null): BrowserSiteAction | null {
  if (!note?.startsWith(BROWSER_ACTION_NOTE_PREFIX)) return null
  try {
    const value = JSON.parse(note.slice(BROWSER_ACTION_NOTE_PREFIX.length)) as Partial<BrowserSiteAction>
    if (
      (value.kind === 'open' || value.kind === 'close') &&
      typeof value.browser === 'string' &&
      typeof value.site === 'string' &&
      typeof value.url === 'string'
    ) {
      return {
        kind: value.kind,
        browser: value.browser,
        site: value.site,
        url: value.url
      }
    }
  } catch {
    return null
  }
  return null
}

export function runBrowserSiteAction(action: BrowserSiteAction): BrowserControlResult {
  const text = `${action.kind} ${action.url} in ${action.browser}`
  return action.kind === 'close' ? closeKnownSite(text) : openKnownSite(text)
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function hasBrowserContext(text: string): boolean {
  return /\b(tab|website|site|page|browser|chrome|google chrome|safari)\b/i.test(text)
}

function extractSiteTarget(text: string): string | null {
  let target = text
    .toLowerCase()
    .replace(/\b(open|launch|start|go to|navigate to|close|quit|exit|shut)\b/g, ' ')
    .replace(/\b(a|an|the|new|tab|website|site|page|application|app)\b/g, ' ')
    .replace(/\b(in|on|with|using|inside|within|while in)\s+(google|chrome|google chrome|safari|browser)\b/g, ' ')
    .replace(/\b(google|chrome|google chrome|safari|browser)\b/g, ' ')
    .replace(/[^a-z0-9-.\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (target === 'google') return null
  if (target.split(' ').length > 1) return null
  if (!/^[a-z0-9-]{2,40}$/.test(target)) return null
  return target
}

function stripUrlLabel(value: string): string {
  return value
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .split(/[/.]/)[0]
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

function titleCase(value: string): string {
  return value.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

function hostnameFor(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, '')
  } catch {
    return url.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0]
  }
}

function appleString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function chromeCloseScript(appName: string, site: ResolvedSite, host: string): string {
  const matchUrl = appleString(host)
  const matchTitle = appleString(site.label)
  return `tell application "${appleString(appName)}"
set closedCount to 0
repeat with w in windows
set tabCount to count of tabs of w
repeat with i from tabCount to 1 by -1
set currentTab to tab i of w
set tabUrl to URL of currentTab as string
set tabTitle to title of currentTab as string
if tabUrl contains "${matchUrl}" or tabTitle contains "${matchTitle}" then
close currentTab
set closedCount to closedCount + 1
end if
end repeat
end repeat
return closedCount
end tell`
}

function safariCloseScript(appName: string, site: ResolvedSite, host: string): string {
  const matchUrl = appleString(host)
  const matchTitle = appleString(site.label)
  return `tell application "${appleString(appName)}"
set closedCount to 0
repeat with w in windows
set tabCount to count of tabs of w
repeat with i from tabCount to 1 by -1
set currentTab to tab i of w
set tabUrl to URL of currentTab as string
set tabTitle to name of currentTab as string
if tabUrl contains "${matchUrl}" or tabTitle contains "${matchTitle}" then
close currentTab
set closedCount to closedCount + 1
end if
end repeat
end repeat
return closedCount
end tell`
}
