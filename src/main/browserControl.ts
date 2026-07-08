import { spawnSync } from 'node:child_process'

type BrowserName = 'chrome' | 'safari'

interface KnownSite {
  label: string
  url: string
  aliases: string[]
}

interface ResolvedSite {
  label: string
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
    aliases: ['gmail', 'google mail']
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

export type BrowserControlResult =
  | { ok: true; browser: string; site: string; url: string }
  | { ok: false; reason: string }

export function resolveBrowser(text: string): BrowserName {
  const lower = text.toLowerCase()
  if (/\bsafari\b/.test(lower)) return 'safari'
  if (/\b(google|chrome|google chrome)\b/.test(lower)) return 'chrome'
  return 'chrome'
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

export function openKnownSite(
  text: string,
  browser: BrowserName = resolveBrowser(text)
): BrowserControlResult {
  const site = resolveSite(text)
  if (!site) {
    return {
      ok: false,
      reason:
        'Autonomy can currently open only known sites such as Gmail, Claude, Google Calendar, Drive, Docs, YouTube, ChatGPT, and Google Search.'
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

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function extractSiteTarget(text: string): string | null {
  let target = text
    .toLowerCase()
    .replace(/\b(open|launch|start|go to|navigate to)\b/g, ' ')
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
