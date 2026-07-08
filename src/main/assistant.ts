import { assistantResponseSchema, type AssistantResponse } from '@shared/schemas'
import { allowlistLabels } from './appOpener'
import { getRawSettings, listMessages, getWritingProfile } from './db'

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
For emails and messages, draft the content but do not send it.`

<<<<<<< HEAD
=======
const OLLAMA_BASE_URL = 'http://127.0.0.1:11434'

>>>>>>> aae2071 (Added Ollama)
function buildSystemPrompt(): string {
  const nowIso = new Date().toISOString()
  const apps = allowlistLabels().join(', ')
  const profile = getWritingProfile()
  const writingBlock = profile
    ? `\n\nThe user's saved writing style profile (use it when drafting emails/messages):\n${profile.summary}`
    : ''

  return `${BASE_SYSTEM_PROMPT}

CURRENT TIME: ${nowIso}
When the user gives a relative time ("in 3 hours", "tomorrow at 4pm"), resolve it to an absolute ISO 8601 datetime string based on CURRENT TIME.

APP CONTROL: you may only schedule opening apps from this exact allowlist: ${apps}. If the user asks for anything else, explain it is not allowed and do not create a scheduled action.${writingBlock}

OUTPUT FORMAT: Respond with ONLY a single JSON object, no markdown, no code fences, no prose outside the JSON. Shape:
{
  "intent": "general_chat | create_task | create_reminder | schedule_app_open | generate_email | update_writing_style | summarize_plan",
  "response": "natural-language reply to show the user",
  "tasks": [ { "title": "string", "due": "ISO or null" } ],
  "reminders": [ { "title": "string", "datetime": "ISO", "recurrence": "none|daily|weekly|monthly" } ],
  "scheduledActions": [ { "app": "allowlisted app name", "datetime": "ISO", "note": "optional" } ],
  "email": { "to": "optional", "subject": "optional", "body": "the draft" }
}
Only include "email" for generate_email. Use empty arrays when nothing applies. "response" is always required.`
}

interface ChatTurn {
  role: 'user' | 'assistant'
  content: string
}

function recentHistory(): ChatTurn[] {
  // last handful of turns for context; keep it short to control token use
  return listMessages(20).map((m) => ({ role: m.role, content: m.content }))
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

<<<<<<< HEAD
=======
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

>>>>>>> aae2071 (Added Ollama)
export class AssistantError extends Error {}

/**
 * Send user text to the configured provider and return a validated response.
 * Throws AssistantError with a user-friendly message on any failure so the
 * renderer can show a clean error state.
 */
export async function runAssistant(userText: string): Promise<AssistantResponse> {
  const s = getRawSettings()
<<<<<<< HEAD
  if (!s.apiKey) {
=======
  if (s.provider !== 'ollama' && !s.apiKey) {
>>>>>>> aae2071 (Added Ollama)
    throw new AssistantError('No API key set. Open Settings and add your key.')
  }
  const system = buildSystemPrompt()
  const history = recentHistory()

  let raw: string
  try {
<<<<<<< HEAD
    raw =
      s.provider === 'openai'
        ? await callOpenAI(s.apiKey, s.model, system, history, userText)
        : await callAnthropic(s.apiKey, s.model, system, history, userText)
  } catch (err) {
=======
    if (s.provider === 'openai') {
      raw = await callOpenAI(s.apiKey, s.model, system, history, userText)
    } else if (s.provider === 'ollama') {
      raw = await callOllama(s.model, system, history, userText)
    } else {
      raw = await callAnthropic(s.apiKey, s.model, system, history, userText)
    }
  } catch (err) {
    if (err instanceof AssistantError) throw err
>>>>>>> aae2071 (Added Ollama)
    throw new AssistantError(`Couldn't reach the model: ${(err as Error).message}`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(stripFences(raw))
  } catch {
    throw new AssistantError('The model returned something that was not valid JSON.')
  }

  const result = assistantResponseSchema.safeParse(parsed)
  if (!result.success) {
    throw new AssistantError(
      `The model's response failed validation: ${result.error.issues
        .map((i) => `${i.path.join('.')} ${i.message}`)
        .join('; ')}`
    )
  }
  return result.data
}

/** Ask the model to summarize the user's writing samples into a style profile. */
export async function summarizeWritingProfile(samples: string[]): Promise<string> {
  const s = getRawSettings()
<<<<<<< HEAD
  if (!s.apiKey) throw new AssistantError('No API key set.')
=======
  if (s.provider !== 'ollama' && !s.apiKey) throw new AssistantError('No API key set.')
>>>>>>> aae2071 (Added Ollama)
  const system =
    'You analyze writing samples and produce a compact, reusable style profile. ' +
    'Describe tone, sentence length, formality, greetings/sign-offs, punctuation habits, ' +
    'and characteristic phrases. Output 4-8 short bullet-like lines of plain text, no preamble.'
  const joined = samples
    .map((t, i) => `--- Sample ${i + 1} ---\n${t}`)
    .join('\n\n')
  const userText = `Here are my writing samples. Summarize my style:\n\n${joined}`

<<<<<<< HEAD
  const raw =
    s.provider === 'openai'
      ? await callOpenAIPlain(s.apiKey, s.model, system, userText)
      : await callAnthropic(s.apiKey, s.model, system, [], userText)
=======
  let raw: string
  if (s.provider === 'openai') {
    raw = await callOpenAIPlain(s.apiKey, s.model, system, userText)
  } else if (s.provider === 'ollama') {
    raw = await callOllamaPlain(s.model, system, userText)
  } else {
    raw = await callAnthropic(s.apiKey, s.model, system, [], userText)
  }
>>>>>>> aae2071 (Added Ollama)
  return raw.trim()
}

async function callOpenAIPlain(
  apiKey: string,
  model: string,
  system: string,
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
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userText }
      ]
    })
  })
  if (!res.ok) throw new AssistantError(`OpenAI API ${res.status}: ${await res.text()}`)
  const data: any = await res.json()
  return data.choices?.[0]?.message?.content ?? ''
}

<<<<<<< HEAD
=======
async function callOllamaPlain(
  model: string,
  system: string,
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
        messages: [
          { role: 'system', content: system },
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

>>>>>>> aae2071 (Added Ollama)
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
