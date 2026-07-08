import { useEffect, useState } from 'react'
import type { WritingProfile, WritingSample } from '@shared/types'

export function WritingStyle() {
  const [samples, setSamples] = useState<WritingSample[]>([])
  const [profile, setProfile] = useState<WritingProfile | null>(null)
  const [draft, setDraft] = useState('')
  const [building, setBuilding] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function refresh(): Promise<void> {
    setSamples(await window.api.listWritingSamples())
    setProfile(await window.api.getWritingProfile())
  }

  useEffect(() => {
    void refresh()
  }, [])

  async function addSample(): Promise<void> {
    const t = draft.trim()
    if (!t) return
    await window.api.addWritingSample(t)
    setDraft('')
    await refresh()
  }

  async function build(): Promise<void> {
    setBuilding(true)
    setError(null)
    try {
      const p = await window.api.buildWritingProfile()
      setProfile(p)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not build profile.')
    } finally {
      setBuilding(false)
    }
  }

  return (
    <div className="form">
      <div className="field">
        <label>Paste a writing sample</label>
        <textarea
          rows={5}
          value={draft}
          placeholder="Paste an email or message you wrote…"
          onChange={(e) => setDraft(e.target.value)}
        />
        <button className="btn" onClick={addSample} disabled={!draft.trim()}>
          Add sample
        </button>
      </div>

      <div className="field">
        <label>Saved samples ({samples.length})</label>
        {samples.length === 0 ? (
          <span className="hint">
            Add a few samples, then build a profile so drafts sound like you.
          </span>
        ) : (
          samples.map((s) => (
            <div key={s.id} className="card">
              <div className="grow">
                <div className="primary">{s.content.slice(0, 60)}…</div>
              </div>
              <button
                className="mini danger"
                onClick={async () => {
                  await window.api.deleteWritingSample(s.id)
                  await refresh()
                }}
              >
                Remove
              </button>
            </div>
          ))
        )}
      </div>

      {error && <div className="banner error">{error}</div>}

      <button
        className="btn primary"
        onClick={build}
        disabled={building || samples.length === 0}
      >
        {building ? 'Analyzing…' : 'Build style profile'}
      </button>

      {profile && (
        <div className="field">
          <label>Current profile</label>
          <div
            className="card"
            style={{ display: 'block', whiteSpace: 'pre-wrap', fontSize: 12 }}
          >
            {profile.summary}
          </div>
          <span className="hint">
            Used automatically when you ask for an email or message “in my
            voice.” The assistant drafts only — it never sends.
          </span>
        </div>
      )}
    </div>
  )
}
