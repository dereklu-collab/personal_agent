# Personal Autonomy Assistant

An always-on-top desktop widget that turns intentions into action. Type or speak a
plan and the assistant extracts tasks, sets reminders, drafts messages in your own
writing style, and schedules approved desktop actions like opening applications.

Built with **Electron + React + TypeScript**, with **SQLite** for local storage,
**Zod** for validating structured AI responses, and your choice of the **Anthropic**
or **OpenAI** API for the assistant (plus **OpenAI Whisper** for voice input).

The widget lives in the bottom-right corner of the screen as a small pill. Click it
to expand a compact panel with four tabs: Chat, Tasks, Style, and Settings.

---

## Quick start

```bash
npm install      # installs deps and rebuilds better-sqlite3 for Electron (postinstall)
npm run dev      # launches the widget in development
```

On first launch an onboarding screen asks for your provider (Anthropic or OpenAI)
and an API key. Everything is stored locally.

To create a production build and preview it:

```bash
npm run build
npm run start    # electron-vite preview
```

Type checking (no emit):

```bash
npm run typecheck        # runs both projects below
npm run typecheck:node   # main + preload + shared
npm run typecheck:web    # renderer + shared
```

### Requirements

- **Node.js 18+** (for native `fetch` and `FormData`/`Blob` used by the API calls).
- A build toolchain for the native `better-sqlite3` module. `npm install` runs
  `electron-rebuild` automatically via the `postinstall` script; if it fails, run
  `npm run rebuild` after installing your platform's build tools
  (Xcode CLT on macOS, `build-essential` + Python on Linux,
  Visual Studio Build Tools on Windows).

---

## How it works

You interact through the chat box (typing or the mic button). Your message is sent
to the main process, which calls the assistant service. The assistant returns a
natural-language reply **and** a structured JSON payload that is validated with Zod
before anything touches the database. Based on the classified intent, the app then:

- **create_task** – adds tasks to the Tasks tab.
- **create_reminder** – schedules a reminder; fires a native desktop notification
  when due (and reschedules if recurring).
- **schedule_app_open** – records a scheduled action to open an allowlisted app at a
  given time. When due it either runs (if auto-approve is on / already approved) or
  asks you to confirm first.
- **generate_email** – drafts an email/message in your saved writing style. Drafts
  only — nothing is ever sent.
- **update_writing_style** – folds pasted samples into a writing-profile summary.
- **summarize_plan / general_chat** – replies conversationally.

A scheduler in the main process polls every 15 seconds for due reminders and due
scheduled actions.

---

## Architecture

```
personal-autonomy-assistant/
├─ electron.vite.config.ts   # three build targets: main, preload, renderer
├─ package.json              # type: module; better-sqlite3 + zod runtime deps
├─ tsconfig*.json            # node (main/preload) and web (renderer) projects
│
├─ src/
│  ├─ shared/                # types + Zod schemas shared across processes
│  │  ├─ types.ts            # domain models + the IPC bridge event union
│  │  └─ schemas.ts          # Zod schema — the single trust boundary for AI output
│  │
│  ├─ main/                  # Electron main process (Node, privileged)
│  │  ├─ index.ts            # window creation, positioning, all IPC handlers
│  │  ├─ db.ts               # better-sqlite3 layer (WAL) + typed CRUD
│  │  ├─ assistant.ts        # provider calls, prompt building, Zod validation, Whisper
│  │  ├─ scheduler.ts        # 15s poll: fires reminders + scheduled actions
│  │  └─ appOpener.ts        # app-open allowlist + safe spawn (no shell)
│  │
│  ├─ preload/               # context-isolated bridge
│  │  └─ index.ts            # exposes a typed window.api via contextBridge
│  │
│  └─ renderer/              # React UI
│     ├─ index.html          # strict CSP
│     └─ src/
│        ├─ App.tsx          # container: state, tabs, event subscription
│        ├─ index.css        # design tokens + all component styles
│        └─ components/      # FloatingWidget, ChatPanel, MicButton,
│                            #   TaskList, SettingsPanel, WritingStyle, Onboarding
```

### Security model (Stage 9)

- **API keys never reach the renderer.** They are stored in SQLite and read only in
  the main process. The renderer receives a masked settings object (booleans like
  `hasApiKey`, never the raw value).
- **Context isolation is on, node integration is off.** The renderer can only call a
  fixed, typed set of methods exposed through the preload `contextBridge`.
- **Every IPC request is validated** in the main process before it acts.
- **The AI cannot run arbitrary commands.** App opening goes through a hardcoded
  allowlist and uses `spawn` with an argument array — never a shell string. Any app
  the model names that isn't on the allowlist is rejected and reported back in chat.
- **Sensitive actions require confirmation** unless you explicitly enable
  auto-approve in Settings.

### Allowlisted apps

Google Chrome, Safari, Notes, Calendar, Slack, Visual Studio Code. macOS uses
`open -a`; Windows and Linux have best-effort equivalents (see `appOpener.ts`).

---

## Known limitations

- **Not yet run end-to-end here.** All code type-checks and the full
  `electron-vite build` succeeds, but the app has not been launched in this
  environment (no display). Run `npm install` then `npm run dev` on your machine.
- **Native module rebuild required.** `better-sqlite3` is a native module and must be
  compiled against your Electron version. This is automated via `postinstall`, but
  needs the platform build tools noted above.
- **Verify model names.** The default model strings (e.g. `claude-3-5-sonnet-latest`,
  `gpt-4o-mini`) are just defaults you can change in Settings. Confirm the current
  model names available to your API key.
- **Voice needs an OpenAI key.** Transcription uses OpenAI Whisper regardless of your
  chat provider. Set a transcription key in Settings (or reuse your OpenAI key).
- **App allowlist is macOS-first.** Windows/Linux launching is best-effort and may
  need per-app tweaks.
- **Reminders fire while the app is running.** The scheduler polls in-process; it does
  not persist OS-level alarms, so the widget needs to be open for reminders to fire.

---

## Future roadmap

Post-MVP directions from the original plan: calendar integration, email integration
(draft-only), browser automation, file search, recurring habits, focus mode,
long-term memory, a mobile companion app, cross-device sync, fuller Windows support,
broader natural-language app control, and automatic daily planning review.

---

## License

MIT
# personal_agent
# personal_agent
# personal_agent
# personal_agent
# personal_agent
# personal_agent
# personal_agent
# personal_agent
# personal_agent
