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

export function SettingsPanel({ settings, allowlist, onSave, onReset }: Props) {
  const [provider, setProvider] = useState(settings.provider)
  const [model, setModel] = useState(settings.model)
  const [apiKey, setApiKey] = useState('')
  const [transcribeKey, setTranscribeKey] = useState('')
  const [autoApprove, setAutoApprove] = useState(settings.autoApproveActions)
  const [saved, setSaved] = useState(false)
  const [logs, setLogs] = useState<ActionLog[]>([])

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
          onChange={(e) => setProvider(e.target.value as PublicSettings['provider'])}
        >
          <option value="anthropic">Anthropic (Claude)</option>
          <option value="openai">OpenAI</option>
        </select>
      </div>

      <div className="field">
        <label>Model</label>
        <input value={model} onChange={(e) => setModel(e.target.value)} />
        <span className="hint">
          Verify the current model name for your provider (e.g. a Claude or GPT
          model you have access to).
        </span>
      </div>

      <div className="field">
        <label>{provider === 'openai' ? 'OpenAI' : 'Anthropic'} API key</label>
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
