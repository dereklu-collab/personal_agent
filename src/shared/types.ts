// Types shared between the main process, preload bridge, and renderer.
// Keep this file free of Node/DOM-only imports so both sides can use it.

export type Intent =
  | 'general_chat'
  | 'create_task'
  | 'create_reminder'
  | 'schedule_app_open'
  | 'generate_email'
  | 'update_writing_style'
  | 'summarize_plan'

export type Provider = 'anthropic' | 'openai' | 'ollama'

export type Recurrence = 'none' | 'daily' | 'weekly' | 'monthly'

export interface Message {
  id: number
  role: 'user' | 'assistant'
  content: string
  intent: Intent | null
  createdAt: string // ISO
}

export interface Task {
  id: number
  title: string
  done: boolean
  due: string | null // ISO or null
  createdAt: string
}

export interface Reminder {
  id: number
  title: string
  datetime: string // ISO, when it fires
  recurrence: Recurrence
  fired: boolean
  dismissed: boolean
  createdAt: string
}

export type ScheduledActionStatus =
  | 'pending' // waiting for its time
  | 'awaiting_confirm' // time reached, needs user approval
  | 'approved' // approved ahead of time; will auto-run
  | 'done'
  | 'cancelled'
  | 'error'

export interface ScheduledAction {
  id: number
  app: string // canonical allowlisted app name
  datetime: string // ISO, when to run
  status: ScheduledActionStatus
  note: string | null
  createdAt: string
}

export interface WritingSample {
  id: number
  content: string
  createdAt: string
}

export interface WritingProfile {
  summary: string
  updatedAt: string
}

export interface ActionLog {
  id: number
  kind: 'scheduled_action' | 'reminder' | 'system'
  message: string
  createdAt: string
}

/** Safe settings shape returned to the renderer — never contains raw keys. */
export interface PublicSettings {
  provider: Provider
  model: string
  hasApiKey: boolean
  hasTranscribeKey: boolean
  autoApproveActions: boolean
  onboarded: boolean
}

/** Draft email produced by the assistant. The app never sends anything. */
export interface EmailDraft {
  to?: string
  subject?: string
  body: string
}

/** Validated, normalized assistant output the UI can rely on. */
export interface AssistantResult {
  userMessage: Message
  assistantMessage: Message
  intent: Intent
  email?: EmailDraft
}

/** The event names main can push to the renderer. */
export type BridgeEvent =
  | { type: 'data-changed' } // lists should refetch
  | { type: 'reminder-due'; reminder: Reminder }
  | { type: 'action-awaiting-confirm'; action: ScheduledAction }
  | { type: 'action-executed'; action: ScheduledAction }
  | { type: 'log'; log: ActionLog }
