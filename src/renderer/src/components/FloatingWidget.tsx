import { useRef } from 'react'
import type { PointerEvent, ReactNode } from 'react'

export type Status = 'idle' | 'thinking' | 'listening' | 'due'
type ResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

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
  const resizeState = useRef<{
    edge: ResizeEdge
    startX: number
    startY: number
    bounds: { x: number; y: number; width: number; height: number }
  } | null>(null)

  async function startResize(
    edge: ResizeEdge,
    event: PointerEvent<HTMLDivElement>
  ): Promise<void> {
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    const bounds = await window.api.getExpandedBounds()
    resizeState.current = {
      edge,
      startX: event.screenX,
      startY: event.screenY,
      bounds
    }
  }

  function updateResize(event: PointerEvent<HTMLDivElement>): void {
    const state = resizeState.current
    if (!state) return
    const dx = event.screenX - state.startX
    const dy = event.screenY - state.startY
    const next = { ...state.bounds }

    if (state.edge.includes('w')) {
      next.x = state.bounds.x + dx
      next.width = state.bounds.width - dx
    }
    if (state.edge.includes('e')) {
      next.width = state.bounds.width + dx
    }
    if (state.edge.includes('n')) {
      next.y = state.bounds.y + dy
      next.height = state.bounds.height - dy
    }
    if (state.edge.includes('s')) {
      next.height = state.bounds.height + dy
    }

    void window.api.resizeExpandedBounds(next)
  }

  function stopResize(event: PointerEvent<HTMLDivElement>): void {
    if (!resizeState.current) return
    resizeState.current = null
    event.currentTarget.releasePointerCapture(event.pointerId)
  }

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
        <span className="title">AI Assistant</span>
        <button onClick={onOpenSettings} title="Settings" aria-label="Settings">
          ⚙
        </button>
        <button onClick={onToggleExpanded} title="Collapse" aria-label="Collapse">
          –
        </button>
      </div>
      {children}
      {(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as ResizeEdge[]).map((edge) => (
        <div
          key={edge}
          className={`resize-zone resize-${edge}`}
          aria-hidden="true"
          onPointerDown={(event) => void startResize(edge, event)}
          onPointerMove={updateResize}
          onPointerUp={stopResize}
          onPointerCancel={stopResize}
        />
      ))}
    </div>
  )
}
