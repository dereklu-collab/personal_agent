import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// SECURITY: the assistant can only ever *name* an app. It can never supply a
// command, arguments, or a path. We resolve that name against this fixed
// allowlist and launch with spawn(argv) — never a shell string — so nothing the
// model emits can be interpreted as a command.

interface AppTarget {
  /** Human label shown in the UI and matched against the model's output. */
  label: string
  /** Alternate names the model might use. */
  aliases: string[]
  /** Per-platform launch spec: [command, ...args]. */
  darwin: string[]
  win32: string[]
  linux: string[]
}

const APPS: AppTarget[] = [
  {
    label: 'Google Chrome',
    aliases: ['chrome', 'google', 'google chrome'],
    darwin: ['open', '-a', 'Google Chrome'],
    win32: ['cmd', '/c', 'start', '', 'chrome'],
    linux: ['google-chrome']
  },
  {
    label: 'Safari',
    aliases: ['safari'],
    darwin: ['open', '-a', 'Safari'],
    win32: [], // not available on Windows
    linux: []
  },
  {
    label: 'Notes',
    aliases: ['notes', 'apple notes'],
    darwin: ['open', '-a', 'Notes'],
    win32: ['cmd', '/c', 'start', '', 'notepad'],
    linux: ['gedit']
  },
  {
    label: 'Calendar',
    aliases: ['calendar', 'ical'],
    darwin: ['open', '-a', 'Calendar'],
    win32: ['cmd', '/c', 'start', '', 'outlookcal:'],
    linux: ['gnome-calendar']
  },
  {
    label: 'Messages',
    aliases: ['messages', 'message', 'imessage', 'i message', 'texts', 'text messages'],
    darwin: ['open', '-a', 'Messages'],
    win32: [],
    linux: []
  },
  {
    label: 'FaceTime',
    aliases: ['facetime', 'face time', 'video call'],
    darwin: ['open', '-a', 'FaceTime'],
    win32: [],
    linux: []
  },
  {
    label: 'Phone',
    aliases: ['phone', 'phone app', 'calls', 'call app'],
    darwin: ['open', '-a', 'Phone'],
    win32: [],
    linux: []
  },
  {
    label: 'Photos',
    aliases: ['photos', 'apple photos', 'pictures', 'photo library'],
    darwin: ['open', '-a', 'Photos'],
    win32: [],
    linux: []
  },
  {
    label: 'Maps',
    aliases: ['maps', 'apple maps', 'map'],
    darwin: ['open', '-a', 'Maps'],
    win32: [],
    linux: []
  },
  {
    label: 'Contacts',
    aliases: ['contacts', 'address book'],
    darwin: ['open', '-a', 'Contacts'],
    win32: [],
    linux: []
  },
  {
    label: 'Mail',
    aliases: ['mail', 'apple mail', 'email app'],
    darwin: ['open', '-a', 'Mail'],
    win32: [],
    linux: []
  },
  {
    label: 'Reminders',
    aliases: ['reminders', 'apple reminders'],
    darwin: ['open', '-a', 'Reminders'],
    win32: [],
    linux: []
  },
  {
    label: 'Music',
    aliases: ['music', 'apple music', 'itunes'],
    darwin: ['open', '-a', 'Music'],
    win32: [],
    linux: []
  },
  {
    label: 'Podcasts',
    aliases: ['podcasts', 'apple podcasts'],
    darwin: ['open', '-a', 'Podcasts'],
    win32: [],
    linux: []
  },
  {
    label: 'Calculator',
    aliases: ['calculator', 'calc'],
    darwin: ['open', '-a', 'Calculator'],
    win32: ['calc'],
    linux: ['gnome-calculator']
  },
  {
    label: 'System Settings',
    aliases: ['settings', 'system settings', 'preferences', 'system preferences'],
    darwin: ['open', '-a', 'System Settings'],
    win32: ['cmd', '/c', 'start', '', 'ms-settings:'],
    linux: ['gnome-control-center']
  },
  {
    label: 'Slack',
    aliases: ['slack'],
    darwin: ['open', '-a', 'Slack'],
    win32: ['cmd', '/c', 'start', '', 'slack'],
    linux: ['slack']
  },
  {
    label: 'Visual Studio Code',
    aliases: ['vscode', 'vs code', 'code', 'visual studio code'],
    darwin: ['open', '-a', 'Visual Studio Code'],
    win32: ['code'],
    linux: ['code']
  }
]

export function allowlistLabels(): string[] {
  return installedApps().map((a) => a.label)
}

/** Resolve a free-text app name to a canonical allowlist label, or null. */
export function resolveApp(name: string): string | null {
  const n = name.trim().toLowerCase()
  for (const app of installedApps()) {
    if (app.label.toLowerCase() === n) return app.label
    if (app.aliases.some((a) => a === n)) return app.label
  }
  // loose contains match as a last resort (e.g. "open chrome browser")
  for (const app of installedApps()) {
    if (n.includes(app.label.toLowerCase())) return app.label
    if (app.aliases.some((a) => n.includes(a))) return app.label
  }
  return null
}

export type OpenResult =
  | { ok: true; label: string }
  | { ok: false; reason: string }

function appNameForPlatform(target: AppTarget): string {
  if (process.platform === 'darwin') return target.darwin.at(-1) ?? target.label
  return target.label
}

function installedApps(): AppTarget[] {
  return APPS.filter(isInstalled)
}

function isInstalled(target: AppTarget): boolean {
  if (process.platform !== 'darwin') return true
  const appName = appNameForPlatform(target)
  const appBundle = `${appName}.app`
  const dirs = [
    '/Applications',
    '/System/Applications',
    '/System/Applications/Utilities',
    join(homedir(), 'Applications')
  ]
  if (dirs.some((dir) => existsSync(join(dir, appBundle)))) return true

  const result = spawnSync('mdfind', [`kMDItemFSName == "${appBundle}"`], {
    encoding: 'utf8'
  })
  return result.status === 0 && result.stdout.trim().length > 0
}

/** Launch an allowlisted app. Rejects anything not on the list. */
export function openApp(name: string): OpenResult {
  const label = resolveApp(name)
  if (!label) {
    return { ok: false, reason: `"${name}" is not on the allowed-apps list.` }
  }
  const target = APPS.find((a) => a.label === label)!
  const platform = process.platform as 'darwin' | 'win32' | 'linux'
  const argv = target[platform] ?? []
  if (argv.length === 0) {
    return { ok: false, reason: `${label} isn't configured for this OS.` }
  }
  const [cmd, ...args] = argv
  try {
    const result = spawnSync(cmd, args, { encoding: 'utf8' })
    if (result.error) {
      return { ok: false, reason: result.error.message }
    }
    if (result.status !== 0) {
      return {
        ok: false,
        reason: (result.stderr || result.stdout || `exit code ${result.status}`).trim()
      }
    }
    return { ok: true, label }
  } catch (err) {
    return { ok: false, reason: (err as Error).message }
  }
}

export function openSystemUrl(url: string, label: string): OpenResult {
  if (process.platform !== 'darwin') {
    return { ok: false, reason: `${label} is only configured for macOS.` }
  }

  try {
    const result = spawnSync('open', [url], { encoding: 'utf8' })
    if (result.error) return { ok: false, reason: result.error.message }
    if (result.status !== 0) {
      return {
        ok: false,
        reason: (result.stderr || result.stdout || `exit code ${result.status}`).trim()
      }
    }
    return { ok: true, label }
  } catch (err) {
    return { ok: false, reason: (err as Error).message }
  }
}

/** Quit an allowlisted app. Rejects anything not on the list. */
export function closeApp(name: string): OpenResult {
  const label = resolveApp(name)
  if (!label) {
    return { ok: false, reason: `"${name}" is not on the allowed-apps list.` }
  }

  const target = APPS.find((a) => a.label === label)!
  try {
    if (process.platform === 'darwin') {
      const appName = appNameForPlatform(target)
      const result = spawnSync('osascript', ['-e', `tell application "${appName}" to quit`], {
        encoding: 'utf8'
      })
      if (result.error) return { ok: false, reason: result.error.message }
      if (result.status !== 0) {
        return {
          ok: false,
          reason: (result.stderr || result.stdout || `exit code ${result.status}`).trim()
        }
      }
      return { ok: true, label }
    }

    return { ok: false, reason: `${label} close control is only configured for macOS.` }
  } catch (err) {
    return { ok: false, reason: (err as Error).message }
  }
}
