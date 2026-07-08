import { useEffect, useState } from 'react'
import type { ActionLog, PublicSettings } from '@shared/types'

interface Props {
  settings: PublicSettings
  allowlist: string[]
  onSave: (
    patch: Partial<PublicSettings> & { apiKey?: string; transcribeKey?: string }
  ) => Promise<void>
  onReset: () => void
}

const MODEL_DEFAULTS: Record<PublicSettings['provider'], string> = {
  anthropic: 'claude-3-5-sonnet-latest',
  openai: 'gpt-4o-mini',
  ollama: 'llama3.1'
}

function providerApiLabel(provider: PublicSettings['provider']): string {
  if (provider === 'openai') return 'OpenAI'
  if (provider === 'anthropic') return 'Anthropic'
  return 'Ollama'
}

export function SettingsPanel({ settings, allowlist, onSave, onReset }: Props) {
  const [provider, setProvider] = useState(settings.provider)
  const [model, setModel] = useState(settings.model)
  const [apiKey, setApiKey] = useState('')
  const [transcribeKey, setTranscribeKey] = useState('')
  const [autoApprove, setAutoApprove] = useState(settings.autoApproveActions)
  const [saved, setSaved] = useState(false)
  const [logs, setLogs] = useState<ActionLog[]>([])
  const usesApiKey = provider !== 'ollama'

  useEffect(() => {
    void window.api.listLogs().then(setLogs)
  }, [])

  async function save(): Promise<void> {
    const patch: Parameters<Props['onSave']>[0] = {
      provider,
      model,
      autoApproveActions: autoApprove
    }
    if (apiKey.trim()) patch.apiKey = apiKey.trim()
    if (transcribeKey.trim()) patch.transcribeKey = transcribeKey.trim()
    await onSave(patch)
    setApiKey('')
    setTranscribeKey('')
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }

  return (
    <div className="form">
      <div className="field">
        <label>Provider</label>
        <select
          value={provider}
          onChange={(e) => {
            const next = e.target.value as PublicSettings['provider']
            setProvider(next)
            setModel(MODEL_DEFAULTS[next])
          }}
        >
          <option value="anthropic">Anthropic (Claude)</option>
          <option value="openai">OpenAI</option>
          <option value="ollama">Local (Ollama)</option>
        </select>
      </div>

      <div className="field">
        <label>Model</label>
        <input value={model} onChange={(e) => setModel(e.target.value)} />
        <span className="hint">
          {provider === 'ollama'
            ? 'Use a local Ollama model you have pulled, such as llama3.1, mistral, or qwen2.5.'
            : 'Verify the current model name for your provider (e.g. a Claude or GPT model you have access to).'}
        </span>
      </div>

      {usesApiKey ? (
        <div className="field">
          <label>{providerApiLabel(provider)} API key</label>
          <input
            type="password"
            placeholder={settings.hasApiKey ? '•••••••• (saved)' : 'Paste key'}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
          <span className="hint">
            Stored locally and only used by the background process. It never
            reaches this window after saving.
          </span>
        </div>
      ) : (
        <div className="field">
          <label>Local provider</label>
          <span className="hint">
            No API key needed. Make sure Ollama is running locally at
            http://127.0.0.1:11434 before chatting.
          </span>
        </div>
      )}

      <div className="field">
        <label>Transcription key (OpenAI Whisper)</label>
        <input
          type="password"
          placeholder={settings.hasTranscribeKey ? '•••••••• (saved)' : 'Optional'}
          value={transcribeKey}
          onChange={(e) => setTranscribeKey(e.target.value)}
        />
        <span className="hint">
          Needed for voice input. If your provider is OpenAI, the key above is
          reused automatically.
        </span>
      </div>

      <div className="row">
        <div>
          <div style={{ fontSize: 13, fontWeight: 600 }}>Auto-approve app launches</div>
          <div className="hint">Skip the confirm step for scheduled apps.</div>
        </div>
        <button
          className={`toggle ${autoApprove ? 'on' : ''}`}
          onClick={() => setAutoApprove((v) => !v)}
          aria-label="Toggle auto-approve"
        />
      </div>

      <button className="btn primary" onClick={save}>
        {saved ? 'Saved ✓' : 'Save settings'}
      </button>

      <div className="field">
        <label>Allowed apps</label>
        <span className="hint">{allowlist.join(', ')}</span>
      </div>

      <div className="field">
        <label>Action log</label>
        {logs.length === 0 ? (
          <span className="hint">No activity yet.</span>
        ) : (
          <div style={{ maxHeight: 140, overflowY: 'auto' }}>
            {logs.map((l) => (
              <div key={l.id} className="meta" style={{ marginBottom: 4 }}>
                {new Date(l.createdAt).toLocaleString([], {
                  month: 'short',
                  day: 'numeric',
                  hour: 'numeric',
                  minute: '2-digit'
                })}{' '}
                — {l.message}
              </div>
            ))}
          </div>
        )}
      </div>

      <button className="btn danger" onClick={onReset}>
        Reset all settings
      </button>
    </div>
  )
}
