import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface NativeSyncResult {
  ok: boolean
  skipped?: boolean
  reason?: string
}

async function runJxa(script: string, args: string[]): Promise<NativeSyncResult> {
  if (process.platform !== 'darwin') {
    return { ok: false, skipped: true, reason: 'macOS native sync only runs on Mac.' }
  }

  try {
    await execFileAsync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script, ...args], {
      timeout: 15_000
    })
    return { ok: true }
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'Unknown macOS automation error'
    return { ok: false, reason: detail }
  }
}

const CALENDAR_EVENT_SCRIPT = `
function run(argv) {
  var title = argv[0];
  var startIso = argv[1];
  var endIso = argv[2];
  var Calendar = Application('Calendar');
  var calendars = Calendar.calendars();
  if (!calendars.length) throw new Error('No calendars are available.');

  var target = calendars[0];
  for (var i = 0; i < calendars.length; i++) {
    try {
      if (calendars[i].writable()) {
        target = calendars[i];
        break;
      }
    } catch (e) {}
  }

  target.events.push(Calendar.Event({
    summary: title,
    startDate: new Date(startIso),
    endDate: new Date(endIso)
  }));
}
`

const REMINDERS_ITEM_SCRIPT = `
function run(argv) {
  var title = argv[0];
  var remindIso = argv[1];
  var Reminders = Application('Reminders');
  var lists = Reminders.lists();
  if (!lists.length) throw new Error('No reminder lists are available.');

  var target = lists[0];
  try {
    target = Reminders.defaultList();
  } catch (e) {}

  target.reminders.push(Reminders.Reminder({
    name: title,
    remindMeDate: new Date(remindIso)
  }));
}
`

export async function createMacCalendarEventForTask(
  title: string,
  startIso: string,
  durationMinutes = 30
): Promise<NativeSyncResult> {
  const start = new Date(startIso)
  if (Number.isNaN(start.getTime())) {
    return { ok: false, skipped: true, reason: 'Task has an invalid due date.' }
  }

  const end = new Date(start.getTime() + durationMinutes * 60_000)
  return runJxa(CALENDAR_EVENT_SCRIPT, [title, start.toISOString(), end.toISOString()])
}

export async function createMacReminder(
  title: string,
  remindIso: string
): Promise<NativeSyncResult> {
  const remindAt = new Date(remindIso)
  if (Number.isNaN(remindAt.getTime())) {
    return { ok: false, skipped: true, reason: 'Reminder has an invalid date.' }
  }

  return runJxa(REMINDERS_ITEM_SCRIPT, [title, remindAt.toISOString()])
}
