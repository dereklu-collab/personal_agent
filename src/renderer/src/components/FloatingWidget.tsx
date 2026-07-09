import { useRef } from 'react'
import type { PointerEvent, ReactNode } from 'react'

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
  const resizeState = useRef<{
    startX: number
    startY: number
    startWidth: number
    startHeight: number
  } | null>(null)

  async function startResize(event: PointerEvent<HTMLButtonElement>): Promise<void> {
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    const size = await window.api.getExpandedSize()
    resizeState.current = {
      startX: event.screenX,
      startY: event.screenY,
      startWidth: size.width,
      startHeight: size.height
    }
  }

  function updateResize(event: PointerEvent<HTMLButtonElement>): void {
    const state = resizeState.current
    if (!state) return
    const width = state.startWidth + (state.startX - event.screenX)
    const height = state.startHeight + (state.startY - event.screenY)
    void window.api.resizeExpanded({ width, height })
  }

  function stopResize(event: PointerEvent<HTMLButtonElement>): void {
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
      <button
        className="resize-grip"
        title="Resize assistant"
        aria-label="Resize assistant"
        onPointerDown={(event) => void startResize(event)}
        onPointerMove={updateResize}
        onPointerUp={stopResize}
        onPointerCancel={stopResize}
      />
    </div>
  )
}
