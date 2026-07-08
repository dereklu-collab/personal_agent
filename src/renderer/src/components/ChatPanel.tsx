import { useEffect, useRef, useState } from 'react'
import type { Message } from '@shared/types'
import { MicButton } from './MicButton'

interface Props {
  messages: Message[]
  sending: boolean
  error: string | null
  onSend: (text: string) => void
  onListeningChange: (listening: boolean) => void
  onMicError: (msg: string) => void
  onDismissError: () => void
}

export function ChatPanel({
  messages,
  sending,
  error,
  onSend,
  onListeningChange,
  onMicError,
  onDismissError
}: Props) {
  const [text, setText] = useState('')
  const [copiedId, setCopiedId] = useState<number | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const shouldAutoScrollRef = useRef(true)

  useEffect(() => {
    if (shouldAutoScrollRef.current) {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
    }
  }, [messages, sending])

  function submit(): void {
    const t = text.trim()
    if (!t || sending) return
    shouldAutoScrollRef.current = true
    onSend(t)
    setText('')
  }

  function updateAutoScrollState(): void {
    const el = scrollRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    shouldAutoScrollRef.current = distanceFromBottom < 32
  }

  async function copyMessage(message: Message): Promise<void> {
    await navigator.clipboard.writeText(message.content)
    setCopiedId(message.id)
    setTimeout(() => setCopiedId(null), 1500)
  }

  return (
    <>
      {error && (
        <div className="banner error" onClick={onDismissError} role="alert">
          {error}
        </div>
      )}

      <div className="messages" ref={scrollRef} onScroll={updateAutoScrollState}>
        {messages.length === 0 && !sending && (
          <div className="empty">
            <div className="big">◇</div>
            <div className="line">Tell me a plan, a reminder, or an app to open.</div>
            <div className="line" style={{ fontSize: 11 }}>
              Try: “Remind me to email Sam at 4pm and open Slack in 2 hours.”
            </div>
          </div>
        )}

        {messages.map((m) => (
          <div key={m.id} className={`msg ${m.role}`}>
            {m.role === 'assistant' &&
              m.intent &&
              m.intent !== 'general_chat' &&
              m.intent !== 'generate_email' &&
              m.intent !== 'create_task' &&
              m.intent !== 'schedule_app_open' && (
              <span className="intent-tag">{m.intent.replace(/_/g, ' ')}</span>
            )}
            {m.content}
            {m.role === 'assistant' && m.intent === 'generate_email' && (
              <button className="msg-copy" onClick={() => void copyMessage(m)}>
                {copiedId === m.id ? 'Copied' : 'Copy'}
              </button>
            )}
          </div>
        ))}

        {sending && (
          <div className="typing">
            <span />
            <span />
            <span />
          </div>
        )}
      </div>

      <div className="composer">
        <textarea
          value={text}
          placeholder="Type a message…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
        />
        <MicButton
          onTranscript={(t) => setText((prev) => (prev ? prev + ' ' + t : t))}
          onError={onMicError}
          onListeningChange={onListeningChange}
        />
        <button
          className="icon-btn send"
          disabled={!text.trim() || sending}
          onClick={submit}
          aria-label="Send"
        >
          ↑
        </button>
      </div>
    </>
  )
}
