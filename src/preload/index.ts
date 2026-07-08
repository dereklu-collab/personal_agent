import { contextBridge, ipcRenderer } from 'electron'
import type {
  ActionLog,
  AssistantResult,
  BridgeEvent,
  Message,
  PublicSettings,
  Reminder,
  ScheduledAction,
  Task,
  WritingProfile,
  WritingSample
} from '@shared/types'

// The renderer only ever sees this object. No Node, no ipcRenderer, no keys.
const api = {
  // window
  setExpanded: (v: boolean): Promise<boolean> =>
    ipcRenderer.invoke('window:setExpanded', v),

  // settings
  getSettings: (): Promise<PublicSettings> => ipcRenderer.invoke('settings:get'),
  setSettings: (patch: Partial<PublicSettings> & {
    apiKey?: string
    transcribeKey?: string
  }): Promise<PublicSettings> => ipcRenderer.invoke('settings:set', patch),
  resetSettings: (): Promise<PublicSettings> =>
    ipcRenderer.invoke('settings:reset'),
  getAllowlist: (): Promise<string[]> => ipcRenderer.invoke('apps:allowlist'),

  // conversation
  sendMessage: (text: string): Promise<AssistantResult> =>
    ipcRenderer.invoke('assistant:send', text),
  transcribe: (bytes: ArrayBuffer, mimeType: string): Promise<string> =>
    ipcRenderer.invoke('assistant:transcribe', { bytes, mimeType }),
  listMessages: (): Promise<Message[]> => ipcRenderer.invoke('messages:list'),
  clearMessages: (): Promise<boolean> => ipcRenderer.invoke('messages:clear'),

  // tasks
  listTasks: (): Promise<Task[]> => ipcRenderer.invoke('tasks:list'),
  toggleTask: (id: number): Promise<Task | null> =>
    ipcRenderer.invoke('tasks:toggle', id),
  updateTaskDue: (id: number, due: string | null): Promise<Task | null> =>
    ipcRenderer.invoke('tasks:updateDue', id, due),
  deleteTask: (id: number): Promise<boolean> =>
    ipcRenderer.invoke('tasks:delete', id),

  // reminders
  listReminders: (): Promise<Reminder[]> => ipcRenderer.invoke('reminders:list'),
  dismissReminder: (id: number): Promise<boolean> =>
    ipcRenderer.invoke('reminders:dismiss', id),

  // scheduled actions
  listActions: (): Promise<ScheduledAction[]> =>
    ipcRenderer.invoke('actions:list'),
  approveAction: (id: number): Promise<ScheduledAction | null> =>
    ipcRenderer.invoke('actions:approve', id),
  cancelAction: (id: number): Promise<boolean> =>
    ipcRenderer.invoke('actions:cancel', id),

  // logs
  listLogs: (): Promise<ActionLog[]> => ipcRenderer.invoke('logs:list'),

  // writing style
  addWritingSample: (content: string): Promise<WritingSample | null> =>
    ipcRenderer.invoke('writing:addSample', content),
  listWritingSamples: (): Promise<WritingSample[]> =>
    ipcRenderer.invoke('writing:listSamples'),
  deleteWritingSample: (id: number): Promise<boolean> =>
    ipcRenderer.invoke('writing:deleteSample', id),
  getWritingProfile: (): Promise<WritingProfile | null> =>
    ipcRenderer.invoke('writing:getProfile'),
  buildWritingProfile: (): Promise<WritingProfile> =>
    ipcRenderer.invoke('writing:buildProfile'),

  // events pushed from main
  onEvent: (cb: (event: BridgeEvent) => void): (() => void) => {
    const listener = (_e: unknown, event: BridgeEvent): void => cb(event)
    ipcRenderer.on('bridge:event', listener)
    return () => ipcRenderer.removeListener('bridge:event', listener)
  }
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
