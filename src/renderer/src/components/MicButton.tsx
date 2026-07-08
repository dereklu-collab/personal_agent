import { useRef, useState } from 'react'

interface Props {
  onTranscript: (text: string) => void
  onError: (msg: string) => void
  onListeningChange: (listening: boolean) => void
}

// Records mic audio with MediaRecorder, then hands the bytes to the main
// process for transcription. The renderer never holds an API key.
export function MicButton({ onTranscript, onError, onListeningChange }: Props) {
  const [state, setState] = useState<'idle' | 'recording' | 'working'>('idle')
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const streamRef = useRef<MediaStream | null>(null)

  async function start(): Promise<void> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      const mime = MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : 'audio/mp4'
      const rec = new MediaRecorder(stream, { mimeType: mime })
      chunksRef.current = []
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data)
      }
      rec.onstop = () => void finish(mime)
      rec.start()
      recorderRef.current = rec
      setState('recording')
      onListeningChange(true)
    } catch {
      onError('Microphone access was blocked. Enable it in your OS settings.')
    }
  }

  function stop(): void {
    recorderRef.current?.stop()
    streamRef.current?.getTracks().forEach((t) => t.stop())
    onListeningChange(false)
  }

  async function finish(mime: string): Promise<void> {
    setState('working')
    try {
      const blob = new Blob(chunksRef.current, { type: mime })
      const bytes = await blob.arrayBuffer()
      const text = await window.api.transcribe(bytes, mime)
      if (text) onTranscript(text)
      else onError('Nothing was transcribed. Try speaking a little longer.')
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Transcription failed.')
    } finally {
      setState('idle')
    }
  }

  const label =
    state === 'recording' ? 'Stop recording' : state === 'working' ? 'Transcribing' : 'Record voice'

  return (
    <button
      className={`icon-btn ${state === 'recording' ? 'recording' : ''}`}
      title={label}
      aria-label={label}
      disabled={state === 'working'}
      onClick={() => (state === 'recording' ? stop() : start())}
    >
      {state === 'working' ? '…' : state === 'recording' ? '■' : '🎙'}
    </button>
  )
}
