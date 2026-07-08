import { useCallback, useEffect, useState } from 'react'
import type {
  PublicSettings,
  Message,
  Reminder,
  ScheduledAction,
  Task
} from '@shared/types'
import { FloatingWidget, type Status } from './components/FloatingWidget'
import { ChatPanel } from './components/ChatPanel'
import { TaskList } from './components/TaskList'
import { SettingsPanel } from './components/SettingsPanel'
import { WritingStyle } from './components/WritingStyle'
import { Onboarding } from './components/Onboarding'

type Tab = 'chat' | 'tasks' | 'style' | 'settings'

export default function App() {
  const [settings, setSettings] = useState<PublicSettings | null>(null)
  const [allowlist, setAllowlist] = useState<string[]>([])
  const [expanded, setExpanded] = useState(false)
  const [tab, setTab] = useState<Tab>('chat')

  const [messages, setMessages] = useState<Message[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [reminders, setReminders] = useState<Reminder[]>([])
  const [actions, setActions] = useState<ScheduledAction[]>([])

  const [sending, setSending] = useState(false)
  const [listening, setListening] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmAction, setConfirmAction] = useState<ScheduledAction | null>(null)

  const refreshLists = useCallback(async () => {
    const [m, t, r, a] = await Promise.all([
      window.api.listMessages(),
      window.api.listTasks(),
      window.api.listReminders(),
      window.api.listActions()
    ])
    setMessages(m)
    setTasks(t)
    setReminders(r)
    setActions(a)
  }, [])

  useEffect(() => {
    void (async () => {
      setSettings(await window.api.getSettings())
      setAllowlist(await window.api.getAllowlist())
      await refreshLists()
    })()

    const unsub = window.api.onEvent((event) => {
      if (event.type === 'data-changed') void refreshLists()
      else if (event.type === 'action-awaiting-confirm') {
        setConfirmAction(event.action)
        void refreshLists()
      } else if (event.type === 'action-executed' || event.type === 'reminder-due') {
        void refreshLists()
      }
    })
    return unsub
  }, [refreshLists])

  async function toggleExpanded(): Promise<void> {
    const next = !expanded
    setExpanded(next)
    await window.api.setExpanded(next)
  }

  async function saveSettings(
    patch: Partial<PublicSettings> & { apiKey?: string; transcribeKey?: string }
  ): Promise<void> {
    setSettings(await window.api.setSettings(patch))
  }

  async function completeOnboarding(
    patch: Partial<PublicSettings> & { apiKey?: string; transcribeKey?: string }
  ): Promise<void> {
    await saveSettings(patch)
  }

  async function resetSettings(): Promise<void> {
    setSettings(await window.api.resetSettings())
    setTab('chat')
  }

  async function send(text: string): Promise<void> {
    setSending(true)
    setError(null)
    try {
      await window.api.sendMessage(text)
      await refreshLists()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.')
      await refreshLists() // the user message was still stored
    } finally {
      setSending(false)
    }
  }

  const activeCount =
    tasks.filter((t) => !t.done).length +
    reminders.filter((r) => !r.fired).length +
    actions.filter((a) =>
      ['pending', 'approved', 'awaiting_confirm'].includes(a.status)
    ).length

  const status: Status = sending
    ? 'thinking'
    : listening
      ? 'listening'
      : confirmAction
        ? 'due'
        : 'idle'

  // First run → onboarding takes the whole panel.
  const needsOnboarding = settings && !settings.onboarded

  return (
    <FloatingWidget
      expanded={expanded}
      status={status}
      activeCount={activeCount}
      onToggleExpanded={toggleExpanded}
      onOpenSettings={() => setTab(tab === 'settings' ? 'chat' : 'settings')}
    >
      {!settings ? (
        <div className="empty">
          <div className="line">Loading…</div>
        </div>
      ) : needsOnboarding ? (
        <Onboarding onComplete={completeOnboarding} />
      ) : (
        <>
          <div className="tabs">
            <button
              className={tab === 'chat' ? 'active' : ''}
              onClick={() => setTab('chat')}
            >
              Chat
            </button>
            <button
              className={tab === 'tasks' ? 'active' : ''}
              onClick={() => setTab('tasks')}
            >
              Tasks
              {activeCount > 0 && <span className="badge">{activeCount}</span>}
            </button>
            <button
              className={tab === 'style' ? 'active' : ''}
              onClick={() => setTab('style')}
            >
              Style
            </button>
            <button
              className={tab === 'settings' ? 'active' : ''}
              onClick={() => setTab('settings')}
            >
              Settings
            </button>
          </div>

          <div className="body">
            {confirmAction && (
              <div className="banner confirm">
                <span className="grow">Open {confirmAction.app} now?</span>
                <button
                  className="mini primary"
                  onClick={async () => {
                    await window.api.approveAction(confirmAction.id)
                    setConfirmAction(null)
                    await refreshLists()
                  }}
                >
                  Open
                </button>
                <button
                  className="mini"
                  onClick={async () => {
                    await window.api.cancelAction(confirmAction.id)
                    setConfirmAction(null)
                    await refreshLists()
                  }}
                >
                  Skip
                </button>
              </div>
            )}

            {tab === 'chat' && (
              <ChatPanel
                messages={messages}
                sending={sending}
                error={error}
                onSend={send}
                onListeningChange={setListening}
                onMicError={setError}
                onDismissError={() => setError(null)}
              />
            )}

            {tab === 'tasks' && (
              <TaskList
                tasks={tasks}
                reminders={reminders}
                actions={actions}
                onToggleTask={async (id) => {
                  await window.api.toggleTask(id)
                  await refreshLists()
                }}
                onDeleteTask={async (id) => {
                  await window.api.deleteTask(id)
                  await refreshLists()
                }}
                onDismissReminder={async (id) => {
                  await window.api.dismissReminder(id)
                  await refreshLists()
                }}
                onApproveAction={async (id) => {
                  await window.api.approveAction(id)
                  await refreshLists()
                }}
                onCancelAction={async (id) => {
                  await window.api.cancelAction(id)
                  await refreshLists()
                }}
              />
            )}

            {tab === 'style' && <WritingStyle />}

            {tab === 'settings' && (
              <SettingsPanel
                settings={settings}
                allowlist={allowlist}
                onSave={saveSettings}
                onReset={resetSettings}
              />
            )}
          </div>
        </>
      )}
    </FloatingWidget>
  )
}
