import { useState } from 'react'
import type { PublicSettings } from '@shared/types'

interface Props {
  onComplete: (
    patch: Partial<PublicSettings> & { apiKey?: string; transcribeKey?: string }
  ) => Promise<void>
}

<<<<<<< HEAD
=======
const MODEL_DEFAULTS: Record<PublicSettings['provider'], string> = {
  anthropic: 'claude-3-5-sonnet-latest',
  openai: 'gpt-4o-mini',
  ollama: 'llama3.1'
}

>>>>>>> aae2071 (Added Ollama)
export function Onboarding({ onComplete }: Props) {
  const [provider, setProvider] = useState<PublicSettings['provider']>('anthropic')
  const [apiKey, setApiKey] = useState('')
  const [saving, setSaving] = useState(false)
<<<<<<< HEAD
=======
  const usesApiKey = provider !== 'ollama'
>>>>>>> aae2071 (Added Ollama)

  async function finish(): Promise<void> {
    setSaving(true)
    await onComplete({
      provider,
<<<<<<< HEAD
      model: provider === 'openai' ? 'gpt-4o-mini' : 'claude-3-5-sonnet-latest',
      apiKey: apiKey.trim() || undefined,
=======
      model: MODEL_DEFAULTS[provider],
      apiKey: usesApiKey ? apiKey.trim() || undefined : undefined,
>>>>>>> aae2071 (Added Ollama)
      onboarded: true
    })
    setSaving(false)
  }

  return (
    <div className="onboarding">
      <h1>Turn intent into action</h1>
      <div className="step">
        <span className="n">1</span>
        <span>Type or speak a plan — I pull out the tasks.</span>
      </div>
      <div className="step">
        <span className="n">2</span>
        <span>Ask for reminders and I’ll nudge you on time.</span>
      </div>
      <div className="step">
        <span className="n">3</span>
        <span>Schedule approved apps to open when you need them.</span>
      </div>

      <div className="field">
        <label>Provider</label>
        <select
          value={provider}
          onChange={(e) => setProvider(e.target.value as PublicSettings['provider'])}
        >
          <option value="anthropic">Anthropic (Claude)</option>
          <option value="openai">OpenAI</option>
<<<<<<< HEAD
        </select>
      </div>
      <div className="field">
        <label>API key</label>
        <input
          type="password"
          placeholder="Paste your key"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
        />
        <span className="hint">
          Stored locally on this machine only. You can add it later in Settings.
        </span>
      </div>
=======
          <option value="ollama">Local (Ollama)</option>
        </select>
      </div>
      {usesApiKey ? (
        <div className="field">
          <label>API key</label>
          <input
            type="password"
            placeholder="Paste your key"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
          <span className="hint">
            Stored locally on this machine only. You can add it later in Settings.
          </span>
        </div>
      ) : (
        <div className="field">
          <label>Local setup</label>
          <span className="hint">
            No key needed. Install Ollama, run it locally, and pull the default
            model with: ollama pull llama3.1
          </span>
        </div>
      )}
>>>>>>> aae2071 (Added Ollama)

      <button className="btn primary" onClick={finish} disabled={saving}>
        {saving ? 'Setting up…' : 'Get started'}
      </button>
    </div>
  )
}
