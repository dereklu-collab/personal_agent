import { assistantResponseSchema, type AssistantResponse } from '@shared/schemas'
import type { Intent } from '@shared/types'
import { allowlistLabels } from './appOpener'
import { getRawSettings, listMessages, getWritingProfile } from './db'

type RawSettings = ReturnType<typeof getRawSettings>

// The embedded system prompt. This is the product's "brain" contract; the
// structured-output rules and live context are appended at call time.
const BASE_SYSTEM_PROMPT = `You are a personal autonomy assistant embedded in a desktop widget.
Your job is to help the user convert intentions into concrete actions.
You can:
- chat with the user
- extract tasks from plans
- create reminders
- summarize daily plans
- draft emails and messages
- adapt writing to the user's saved writing style
- schedule approved desktop actions like opening applications
You must be concise, practical, and action-oriented.
When the user gives a plan, extract tasks clearly.
When the user asks for a reminder, identify: reminder title, date, time, and recurrence if any.
When the user asks to open an application later, create a scheduled action.
Never execute sensitive actions without confirmation.
Never invent completed actions. If something is only scheduled, say it is scheduled.
For emails and messages, draft the content only. Never offer to send an email or ask whether to send it. The desktop app cannot send emails.`

const OLLAMA_BASE_URL = 'http://127.0.0.1:11434'

function buildSystemPrompt(): string {
  const nowIso = new Date().toISOString()
  const apps = allowlistLabels().join(', ')
  const profile = getWritingProfile()
  const writingBlock = profile
    ? `\n\nThe user's saved writing style profile (use it strongly when drafting emails/messages). Match the user's tone, greeting style, sentence rhythm, punctuation, and preferred sign-off if one is present:\n${profile.summary}`
    : ''

  return `${BASE_SYSTEM_PROMPT}

CURRENT TIME: ${nowIso}
When the user gives a relative time ("in 3 hours", "tomorrow at 4pm"), resolve it to an absolute ISO 8601 datetime string based on CURRENT TIME.

APP CONTROL: you may only schedule opening apps from this exact allowlist: ${apps}. If the user asks for anything else, explain it is not allowed and do not create a scheduled action.${writingBlock}

OUTPUT FORMAT: Respond with ONLY a single JSON object, no markdown, no code fences, no prose outside the JSON. Shape:
{
  "intent": "generate_email",
  "response": "natural-language reply to show the user",
  "tasks": [ { "title": "string", "due": "ISO or null" } ],
  "reminders": [ { "title": "string", "datetime": "ISO", "recurrence": "none|daily|weekly|monthly" } ],
  "scheduledActions": [ { "app": "allowlisted app name", "datetime": "ISO", "note": "optional" } ],
  "email": { "to": "optional", "subject": "optional", "body": "the draft" }
}
Valid intent values are: general_chat, create_task, create_reminder, schedule_app_open, generate_email, update_writing_style, summarize_plan.
Choose exactly one intent value. Never combine intent values with "|" or commas.
Only include "email" for generate_email. Do not include "email" for tasks, reminders, scheduled app launches, plans, or general chat. For generate_email, write a complete copy-and-pasteable email in email.body with a greeting, body, and closing/sign-off. Use only the user's current email request unless they explicitly reference prior context with words like "that", "this", "previous", or "the meeting". Never create tasks, reminders, or scheduled actions while drafting an email. Use the saved writing profile's sign-off when available; otherwise use a natural sign-off such as "Best regards,". Make response a short intro such as "Here is a draft you can copy and paste." Do not ask whether to send it. Use empty arrays when nothing applies. "response" is always required.`
}

interface ChatTurn {
  role: 'user' | 'assistant'
  content: string
}

function recentHistory(): ChatTurn[] {
  // last handful of turns for context; keep it short to control token use
  return listMessages(20).map((m) => ({ role: m.role, content: m.content }))
}

function isEmailDraftRequest(text: string): boolean {
  return (
    /\b(write|draft|compose|generate|create)\b.*\b(e-?mail|message|reply)\b/i.test(text) ||
    /\b(e-?mail|message|reply)\s+to\b/i.test(text)
  )
}

function referencesPriorContext(text: string): boolean {
  return /\b(that|this|it|previous|above|earlier|last|same|the meeting|that meeting|the task|that task|the reminder|that reminder)\b/i.test(
    text
  )
}

function historyForRequest(userText: string): ChatTurn[] {
  if (isEmailDraftRequest(userText) && !referencesPriorContext(userText)) {
    return []
  }
  const history = recentHistory()
  const last = history.at(-1)
  if (last?.role === 'user' && last.content.trim() === userText.trim()) {
    return history.slice(0, -1)
  }
  return history
}

function stripFences(text: string): string {
  let t = text.trim()
  if (t.startsWith('```')) {
    t = t.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  }
  // Fall back to the first {...} block if the model added stray prose.
  const first = t.indexOf('{')
  const last = t.lastIndexOf('}')
  if (first > 0 && last > first) t = t.slice(first, last + 1)
  return t
}

const VALID_INTENTS: Intent[] = [
  'general_chat',
  'create_task',
  'create_reminder',
  'schedule_app_open',
  'generate_email',
  'update_writing_style',
  'summarize_plan'
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasItems(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

function intentFromSideEffects(payload: Record<string, unknown>): Intent | null {
  if (hasItems(payload.scheduledActions)) return 'schedule_app_open'
  if (hasItems(payload.reminders)) return 'create_reminder'
  if (hasItems(payload.tasks)) return 'create_task'
  return null
}

function normalizeAssistantPayload(payload: unknown): unknown {
  if (!isRecord(payload)) return payload
  const intent = payload.intent
  let next = { ...payload }
  const sideEffectIntent = intentFromSideEffects(payload)

  if (typeof intent === 'string' && !VALID_INTENTS.includes(intent as Intent)) {
    const candidates = VALID_INTENTS.filter((value) => intent.includes(value))
    let normalized: Intent | null = null

    if (sideEffectIntent) {
      normalized = sideEffectIntent
    } else if (isRecord(payload.email) || candidates.includes('generate_email')) {
      normalized = 'generate_email'
    } else {
      normalized = candidates.find((value) => value !== 'general_chat') ?? 'general_chat'
    }

    next = { ...next, intent: normalized }
  }

  if (next.intent === 'generate_email') {
    const email = isRecord(next.email) ? next.email : {}
    const hasEmailLikeDraft = firstString(
      email.body,
      email.draft,
      email.content,
      email.text,
      next.emailBody,
      next.draft
    )

    if (!hasEmailLikeDraft && sideEffectIntent) {
      const rest = { ...next }
      delete rest.email
      return { ...rest, intent: sideEffectIntent }
    }

    const body = firstString(
      email.body,
      email.draft,
      email.content,
      email.text,
      next.emailBody,
      next.draft,
      sideEffectIntent ? null : next.response
    )

    if (body) {
      next = {
        ...next,
        response: 'Here is a draft you can copy and paste.',
        tasks: [],
        reminders: [],
        scheduledActions: [],
        email: {
          ...email,
          body
        }
      }
    }
  }

  return next
}

async function callAnthropic(
  apiKey: string,
  model: string,
  system: string,
  history: ChatTurn[],
  userText: string
): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      system,
      messages: [...history, { role: 'user', content: userText }]
    })
  })
  if (!res.ok) {
    throw new Error(`Anthropic API ${res.status}: ${await res.text()}`)
  }
  const data: any = await res.json()
  const block = (data.content ?? []).find((c: any) => c.type === 'text')
  return block?.text ?? ''
}

async function callOpenAI(
  apiKey: string,
  model: string,
  system: string,
  history: ChatTurn[],
  userText: string
): Promise<string> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        ...history,
        { role: 'user', content: userText }
      ]
    })
  })
  if (!res.ok) {
    throw new Error(`OpenAI API ${res.status}: ${await res.text()}`)
  }
  const data: any = await res.json()
  return data.choices?.[0]?.message?.content ?? ''
}

async function callOllama(
  model: string,
  system: string,
  history: ChatTurn[],
  userText: string
): Promise<string> {
  let res: Response
  try {
    res = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        format: 'json',
        messages: [
          { role: 'system', content: system },
          ...history,
          { role: 'user', content: userText }
        ]
      })
    })
  } catch {
    throw new AssistantError(
      `Ollama is not reachable at ${OLLAMA_BASE_URL}. Install Ollama, start it, and pull the selected model with: ollama pull ${model}`
    )
  }
  if (!res.ok) {
    const body = await res.text()
    const missingModel = res.status === 404 || body.toLowerCase().includes('not found')
    if (missingModel) {
      throw new AssistantError(
        `Ollama could not find the model "${model}". Pull it first with: ollama pull ${model}`
      )
    }
    throw new Error(`Ollama API ${res.status}: ${body}`)
  }
  const data: any = await res.json()
  return data.message?.content ?? data.response ?? ''
}

export class AssistantError extends Error {}

function validationIssues(error: { issues: { path: (string | number)[]; message: string }[] }): string {
  return error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')
}

async function callConfiguredModel(
  settings: RawSettings,
  system: string,
  history: ChatTurn[],
  userText: string
): Promise<string> {
  if (settings.provider === 'openai') {
    return callOpenAI(settings.apiKey, settings.model, system, history, userText)
  }
  if (settings.provider === 'ollama') {
    return callOllama(settings.model, system, history, userText)
  }
  return callAnthropic(settings.apiKey, settings.model, system, history, userText)
}

async function callConfiguredPlainModel(
  settings: RawSettings,
  system: string,
  userText: string,
  history: ChatTurn[] = []
): Promise<string> {
  if (settings.provider === 'openai') {
    return callOpenAIPlain(settings.apiKey, settings.model, system, userText, history)
  }
  if (settings.provider === 'ollama') {
    return callOllamaPlain(settings.model, system, userText, history)
  }
  return callAnthropic(settings.apiKey, settings.model, system, history, userText)
}

function parseAssistantResponse(raw: string): AssistantResponse {
  let parsed: unknown
  try {
    parsed = normalizeAssistantPayload(JSON.parse(stripFences(raw)))
  } catch {
    throw new AssistantError('The model returned something that was not valid JSON.')
  }

  const result = assistantResponseSchema.safeParse(parsed)
  if (!result.success) {
    throw new AssistantError(
      `The model's response failed validation: ${validationIssues(result.error)}`
    )
  }
  return result.data
}

function repairPrompt(originalText: string, failure: string): string {
  return `The previous attempt failed because the structured JSON was invalid: ${failure}

Answer the user's original request again, but return only valid JSON in the required schema. If a trailing detail makes the request ambiguous, keep the useful core request and ignore only the confusing trailing detail.

Original user request:
${originalText}`
}

function cleanStyledEmailBody(text: string): string {
  return text
    .trim()
    .replace(/^```(?:text|markdown)?/i, '')
    .replace(/```$/i, '')
    .replace(
      /^(?:here\s+is\s+)?(?:the\s+)?(?:revised\s+)?(?:email\s+)?(?:body|draft)\s*:?\s*/i,
      ''
    )
    .trim()
}

async function applyWritingStyleToEmail(
  response: AssistantResponse,
  settings: RawSettings
): Promise<AssistantResponse> {
  if (response.intent !== 'generate_email' || !response.email?.body.trim()) return response

  const profile = getWritingProfile()
  if (!profile?.summary.trim()) return response

  const system =
    'You are an email style editor. Revise the provided draft so it matches the saved writing style profile. ' +
    'Preserve the same recipient, purpose, facts, names, dates, locations, and ask. ' +
    'Lightly fix grammar and clarity, but do not completely rewrite the message or add new details. ' +
    'Use the profile greeting/sign-off habits when present. Output only the revised email body.'

  const userText = `Saved writing style profile:
${profile.summary}

Draft email body:
${response.email.body}

Revise the draft to match the saved style profile while keeping the same meaning and details.`

  try {
    const styledBody = cleanStyledEmailBody(
      await callConfiguredPlainModel(settings, system, userText)
    )
    if (!styledBody) return response
    return {
      ...response,
      email: {
        ...response.email,
        body: styledBody
      }
    }
  } catch {
    return response
  }
}

/**
 * Send user text to the configured provider and return a validated response.
 * Throws AssistantError with a user-friendly message on any failure so the
 * renderer can show a clean error state.
 */
export async function runAssistant(userText: string): Promise<AssistantResponse> {
  const s = getRawSettings()
  if (s.provider !== 'ollama' && !s.apiKey) {
    throw new AssistantError('No API key set. Open Settings and add your key.')
  }
  const system = buildSystemPrompt()
  const history = historyForRequest(userText)

  let raw: string
  try {
    raw = await callConfiguredModel(s, system, history, userText)
  } catch (err) {
    if (err instanceof AssistantError) throw err
    throw new AssistantError(`Couldn't reach the model: ${(err as Error).message}`)
  }

  try {
    return await applyWritingStyleToEmail(parseAssistantResponse(raw), s)
  } catch (firstErr) {
    const failure = firstErr instanceof Error ? firstErr.message : 'Unknown validation error.'
    try {
      const retryRaw = await callConfiguredModel(
        s,
        system,
        history,
        repairPrompt(userText, failure)
      )
      return await applyWritingStyleToEmail(parseAssistantResponse(retryRaw), s)
    } catch (retryErr) {
      if (retryErr instanceof AssistantError) throw retryErr
      throw new AssistantError(`Couldn't repair the model response: ${(retryErr as Error).message}`)
    }
  }
}

/** Answer normal chat/follow-up questions without creating side effects. */
export async function runGeneralChat(userText: string): Promise<string> {
  const s = getRawSettings()
  if (s.provider !== 'ollama' && !s.apiKey) {
    throw new AssistantError('No API key set. Open Settings and add your key.')
  }
  const system =
    'You are AI Assistant, a concise desktop assistant. Answer normal questions and follow-up questions using the recent chat context. ' +
    'Before answering calculations, unit conversions, timezone conversions, dates, or factual numeric questions, briefly verify the arithmetic and do not guess. ' +
    'Do not create tasks, reminders, scheduled actions, emails, calls, or app/browser actions in this fallback mode. ' +
    'If the user asks whether a previous live lookup is accurate as of today, explain that it was retrieved from the live lookup at the time it was shown, but market/weather/web data can change and they can ask again to refresh it. ' +
    'If the user asks what commands are supported, tell them to type /help. Keep the answer brief and useful.'
  const raw = await callConfiguredPlainModel(s, system, userText, historyForRequest(userText))
  return raw.trim()
}

/** Ask the model to summarize the user's writing samples into a style profile. */
export async function summarizeWritingProfile(samples: string[]): Promise<string> {
  const s = getRawSettings()
  if (s.provider !== 'ollama' && !s.apiKey) throw new AssistantError('No API key set.')
  const system =
    'You analyze writing samples and produce a compact, reusable style profile. ' +
    'Describe tone, sentence length, formality, greetings/sign-offs, punctuation habits, ' +
    'and characteristic phrases. Include exact preferred greetings and sign-offs when visible, ' +
    'or say when the samples do not show a consistent one. Output 4-8 short bullet-like lines of plain text, no preamble.'
  const joined = samples
    .map((t, i) => `--- Sample ${i + 1} ---\n${t}`)
    .join('\n\n')
  const userText = `Here are my writing samples. Summarize my style:\n\n${joined}`

  let raw: string
  if (s.provider === 'openai') {
    raw = await callOpenAIPlain(s.apiKey, s.model, system, userText)
  } else if (s.provider === 'ollama') {
    raw = await callOllamaPlain(s.model, system, userText)
  } else {
    raw = await callAnthropic(s.apiKey, s.model, system, [], userText)
  }
  return raw.trim()
}

/** Summarize user-provided text as a plain chat skill, without side effects. */
export async function summarizeText(text: string): Promise<string> {
  const s = getRawSettings()
  if (s.provider !== 'ollama' && !s.apiKey) {
    throw new AssistantError('No API key set. Open Settings and add your key.')
  }
  const system =
    'You summarize user-provided text clearly and concisely. Preserve important names, dates, decisions, and action items. ' +
    'Return only the summary in plain text. Do not create tasks, reminders, emails, or scheduled actions.'
  const userText = `Summarize this text:\n\n${text}`
  const raw = await callConfiguredPlainModel(s, system, userText)
  return raw.trim()
}

async function callOpenAIPlain(
  apiKey: string,
  model: string,
  system: string,
  userText: string,
  history: ChatTurn[] = []
): Promise<string> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: system },
        ...history,
        { role: 'user', content: userText }
      ]
    })
  })
  if (!res.ok) throw new AssistantError(`OpenAI API ${res.status}: ${await res.text()}`)
  const data: any = await res.json()
  return data.choices?.[0]?.message?.content ?? ''
}

async function callOllamaPlain(
  model: string,
  system: string,
  userText: string,
  history: ChatTurn[] = []
): Promise<string> {
  let res: Response
  try {
    res = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        messages: [
          { role: 'system', content: system },
          ...history,
          { role: 'user', content: userText }
        ]
      })
    })
  } catch {
    throw new AssistantError(
      `Ollama is not reachable at ${OLLAMA_BASE_URL}. Install Ollama, start it, and pull the selected model with: ollama pull ${model}`
    )
  }
  if (!res.ok) {
    const body = await res.text()
    const missingModel = res.status === 404 || body.toLowerCase().includes('not found')
    if (missingModel) {
      throw new AssistantError(
        `Ollama could not find the model "${model}". Pull it first with: ollama pull ${model}`
      )
    }
    throw new AssistantError(`Ollama API ${res.status}: ${body}`)
  }
  const data: any = await res.json()
  return data.message?.content ?? data.response ?? ''
}

/**
 * Transcribe audio bytes via OpenAI Whisper. Uses the dedicated transcribe key
 * if set, otherwise the main API key (only valid when provider is OpenAI).
 */
export async function transcribeAudio(
  bytes: ArrayBuffer,
  mimeType: string
): Promise<string> {
  const s = getRawSettings()
  const key = s.transcribeKey || (s.provider === 'openai' ? s.apiKey : '')
  if (!key) {
    throw new AssistantError(
      'Voice needs an OpenAI key. Add one under Settings → Transcription key.'
    )
  }
  const ext = mimeType.includes('webm') ? 'webm' : mimeType.includes('mp4') ? 'mp4' : 'wav'
  const form = new FormData()
  form.append('file', new Blob([bytes], { type: mimeType }), `audio.${ext}`)
  form.append('model', 'whisper-1')

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}` },
    body: form
  })
  if (!res.ok) {
    throw new AssistantError(`Transcription failed ${res.status}: ${await res.text()}`)
  }
  const data: any = await res.json()
  return (data.text ?? '').trim()
}
