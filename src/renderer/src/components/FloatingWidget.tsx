import type { ReactNode } from 'react'

export type Status = 'idle' | 'thinking' | 'listening' | 'due'

interface Props {
  expanded: boolean
  status: Status
  activeCount: number
  onToggleExpanded: () => void
  onOpenSettings: () => void
  children: ReactNode
}

export function FloatingWidget({
  expanded,
  status,
  activeCount,
  onToggleExpanded,
  onOpenSettings,
  children
}: Props) {
  if (!expanded) {
    return (
      <div className="pill">
        <span className="pill-grip" title="Drag to move" aria-hidden="true">
          ⋮⋮
        </span>
        <button
          className="pill-open"
          onClick={onToggleExpanded}
          title="Open assistant"
        >
          <span className={`dot ${status}`} />
          <span className="pill-label">Assistant</span>
          {activeCount > 0 && <span className="pill-count">{activeCount}</span>}
        </button>
      </div>
    )
  }

  return (
    <div className="panel">
      <div className="header">
        <span className={`dot ${status}`} />
        <span className="title">Autonomy Assistant</span>
        <button onClick={onOpenSettings} title="Settings" aria-label="Settings">
          ⚙
        </button>
        <button onClick={onToggleExpanded} title="Collapse" aria-label="Collapse">
          –
        </button>
      </div>
      {children}
    </div>
  )
}
