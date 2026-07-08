import { spawnSync } from 'node:child_process'

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
    aliases: ['chrome', 'google chrome'],
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
  return APPS.map((a) => a.label)
}

/** Resolve a free-text app name to a canonical allowlist label, or null. */
export function resolveApp(name: string): string | null {
  const n = name.trim().toLowerCase()
  for (const app of APPS) {
    if (app.label.toLowerCase() === n) return app.label
    if (app.aliases.some((a) => a === n)) return app.label
  }
  // loose contains match as a last resort (e.g. "open chrome browser")
  for (const app of APPS) {
    if (n.includes(app.label.toLowerCase())) return app.label
    if (app.aliases.some((a) => n.includes(a))) return app.label
  }
  return null
}

export type OpenResult =
  | { ok: true; label: string }
  | { ok: false; reason: string }

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
