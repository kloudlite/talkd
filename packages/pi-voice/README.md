# @talkd/pi-voice

Pi package that adds a clean, headless F12 Talkd copilot to Pi.

Talkd runs as a separate side-agent context and does not continuously listen in the background. Press F12 to explicitly start microphone capture. When the terminal emits key-repeat events while F12 is held, Talkd ignores the repeats and infers release when repeats stop, then sends the utterance. If your terminal does not emit usable repeats/release signals, press F12 again to stop recording and send.

It uses:

- Pi extension API for commands, shortcuts, status, and the compact Talkd widget
- `talkd-service` for local STT/TTS over `~/.talkd/talkd.sock`
- SoX `rec` for microphone capture by default
- `afplay` for playback by default on macOS

## Setup

The curl installer installs this package under `~/.talkd/pi-voice` without cloning the repo, then registers it with Pi. Runtime/binary download details live in `../../scripts/README.md`.

One-command install from GitHub:

```bash
curl -fsSL https://raw.githubusercontent.com/kloudlite/talkd/main/scripts/install.sh | bash
```

From the repo root you can also run setup explicitly:

```bash
bun install
bun run --cwd packages/pi-voice setup:runtime
bun run build
```

For distribution validation, run the root Dagger gate instead:

```bash
bun run ci
```

Set `TALKD_PI_VOICE_SKIP_SETUP=1` to skip install-time setup, or `TALKD_PI_VOICE_FORCE_SETUP=1` to force reinstall checks.

Runtime setup currently supports macOS arm64/x64 and Linux x64/arm64. Native Windows is not currently supported by the Unix-socket service/setup path. On Linux, set `TALKD_PLAY_CMD` to an available WAV player such as `aplay {file}` or `paplay {file}`.

## Try without installing

```bash
pi -e ./packages/pi-voice/src/index.ts
```

Inside Pi:

```text
F12 down  start recording
F12 up    send after Talkd infers release from stopped key repeats
F12 again fallback: stop recording and send
F12 while speaking/thinking: interrupt and start recording
```

Fallback shortcut:

```text
Ctrl+Shift+V
```

No floating panel is shown. When Pi's editor hook is available, Talkd uses the input border color as the primary state indicator: accent while recording, warning while transcribing/thinking, success while speaking, and error on failures. While active, a tiny right-side token is rendered inside the editor border: `REC`, `STT`, `THINK`, `TTS`, `PLAY`, or `ERR`; it is hidden when idle. Talkd does not use routine footer/status text or below-editor widget hints. If another custom editor prevents this hook, Talkd does not add a verbose fallback indicator. On session start, the extension ensures `talkd-service` is running in the background: it reuses an existing service if one responds on the socket, otherwise it starts `~/.talkd/bin/talkd-service` or the local checkout service without blocking the active Pi UI. Detailed transcript/timing/playback debug output is hidden by default and can be written to a file with `TALKD_VOICE_DEBUG=1`.

The transcript is **not** blindly pasted into the main Pi session. The Talkd side-agent is read-only/coordination-only: it does not receive Pi file-editing, write, bash, or other coding tools. Instead:

1. Your speech goes to the Talkd side-agent context.
2. Talkd reads a live snapshot/recent event log of the main harness.
3. It answers you conversationally.
4. If work should happen in the harness, it uses its `send_to_harness` tool to send a clear instruction to the main Pi session.

You can also use:

```text
/voice
```

## Install as project-local Pi package

```bash
pi install -l ./packages/pi-voice
```

Then restart Pi or run:

```text
/reload
```

## Commands

```text
/voice  same as F12: start/send/interrupt recording
```

## Environment variables

```bash
# talkd socket
export TALKD_SOCK="$HOME/.talkd/talkd.sock"

# install location for runtime assets and the default service binary
export TALKD_HOME="$HOME/.talkd"

# service startup override
export TALKD_SERVICE_CMD="$HOME/.talkd/bin/talkd-service --sock $HOME/.talkd/talkd.sock"

# microphone capture command, must output raw pcm16le mono 16k to stdout.
# This command runs only during active Talkd recording.
export TALKD_RECORD_CMD='rec -q -t raw -b 16 -e signed-integer -c 1 -r 16000 -'

# recording safety cap; prevents accidental open-mic recording
export TALKD_PUSH_TO_TALK_MAX_MS=120000

# max gap between terminal key-repeat events while inferring F12 release
export TALKD_RECORDING_KEY_REPEAT_GAP_MS=900

# playback command; {file} is replaced with generated wav path
export TALKD_PLAY_CMD='afplay {file}'

# minimum gap between proactive spoken harness updates
export TALKD_MIN_PROACTIVE_GAP_MS=10000

# minimum gap between intermittent updates while the main harness is still busy
export TALKD_BUSY_PROACTIVE_MIN_GAP_MS=60000

# persisted Talkd recent state; stores only recent Talkd turns/decisions
# defaults to ~/.pi/agent/talkd-voice-state.json
export TALKD_VOICE_STATE_PATH="$HOME/.pi/agent/talkd-voice-state.json"
export TALKD_VOICE_RECENT_TURNS=16
export TALKD_VOICE_RECENT_DECISIONS=20

# incremental speech synthesis chunking; larger chunks sound more natural
export TALKD_STREAMING_TTS_MIN_CHARS=110
export TALKD_STREAMING_TTS_MIN_WORDS=16
export TALKD_STREAMING_TTS_CHUNK_CHARS=280

# optional: persist Talkd's own lightweight side-agent session.
# unset by default; Talkd does not fork/copy the full main Pi session.
# export TALKD_VOICE_SESSION_DIR="$HOME/.pi/agent/sessions/talkd-voice"

# optional debug logging; writes to a file instead of the active Pi display by default
export TALKD_VOICE_DEBUG=1
export TALKD_VOICE_DEBUG_LOG=/tmp/talkd-pi-voice-debug.log

# optional latency/stuck-thinking diagnostics only; also writes to TALKD_VOICE_DEBUG_LOG
export TALKD_VOICE_LATENCY_DEBUG=1
export TALKD_VOICE_AGENT_TIMEOUT_MS=120000
export TALKD_VOICE_THINKING_NOTICE_MS=12000
export TALKD_VOICE_THINKING_NOTICE_INTERVAL_MS=10000

# optional: show a one-line debug widget in Pi (off by default to keep UI clear)
export TALKD_VOICE_DEBUG_UI=1
```

## Talkd side-agent skill

Talkd's runtime side-agent activates a dedicated side-agent skill from `side-agent-skills/talkd-side-agent-voice-copilot/SKILL.md`. The extension loads only that explicit skill path while keeping default skill discovery disabled, then injects the skill content into hidden side-agent context. This keeps the runtime lightweight while giving Talkd its actual speaking/watching behavior.

The `@talkd/pi-voice` package intentionally does not install any primary-session Pi skills. The main coding harness loads the extension only; Talkd-specific skill behavior belongs inside the separate voice side-agent session.

## Side-agent architecture

Talkd uses a lightweight side-agent context so spoken interaction stays responsive even when the main Pi transcript is large.

For each Talkd turn, the side-agent gets context in this form:

1. **Current harness snapshot in the prompt.** The prompt includes the visible Pi harness state, recent event log, editor text, and branch summary.
2. **Talkd side-agent instructions and activated side-agent skill.** Hidden marked messages define Talkd's role, speaking/watching behavior, and read-only/coordination-only contract.
3. **Persisted recent Talkd conversation and decisions.** A small Talkd-specific state record is appended for spoken continuity and recency.

The full main Pi transcript is no longer prepended to the Talkd side-agent context by default. When Talkd needs fresher details, it uses the `get_harness_state` coordination tool.

By default, only Talkd-specific recent state is persisted:

```text
~/.pi/agent/talkd-voice-state.json
```

Configure it with:

- `TALKD_VOICE_STATE_PATH` — override the state file path.
- `TALKD_VOICE_RECENT_TURNS` — number of recent Talkd user/assistant turns to keep; default `16`.
- `TALKD_VOICE_RECENT_DECISIONS` — number of proactive decision records to keep; default `20`.

`TALKD_VOICE_SESSION_DIR` is intentionally **unset by default**. If set, Talkd may persist its own lightweight side-agent session in that directory. It does not fork or copy the full active main Pi session by default.

### Coordination-only tools

Talkd does not receive direct coding tools. It cannot directly read, edit, write files, run shell commands, or inspect the filesystem. Its tools are limited to coordination:

- `get_harness_state` — inspect the visible Pi harness snapshot, recent events, editor text, and branch summary.
- `send_to_harness` — send a user-approved actionable instruction to the main Pi harness.
- `add_harness_note` — add a hidden note to the main harness context without directly performing work.

### Proactive decision records

When the main harness changes, Talkd decides whether to stay quiet or speak a short update. Proactive coordination has two allowed modes: necessary attention-needed moments and meaningful high-level behind-the-scenes progress. For attention-needed moments, Talkd should interrupt for a user decision/action requirement, requested watch completion, failure, or surprising important state change. For progress, Talkd may summarize phase changes, evidence found, likely root-cause direction, validation results, and next action, but it must not narrate every tool event, command, or small step. Both spoken and silent outcomes are recorded in Talkd's recent state and, for the current side-agent turn, as hidden marked context:

```text
<<<TALKD_PROACTIVE_DECISION_BEGIN>>>
record_type: proactive_harness_update_decision
decision: SILENCE | SPOKEN_UPDATE
...
<<<TALKD_PROACTIVE_DECISION_END>>>
```

These records are distinguishable from normal user/assistant turns and from main harness snapshot/tool context.

### Spoken detail level

Talkd defaults to short spoken replies, but may give more detailed explanations when the user explicitly asks, when a complex topic needs detail for understanding, or when summarizing meaningful behind-the-scenes progress. Detailed replies should stay conversational, avoid per-tool narration, and offer or continue with more detail only if useful.

### User-action diagnostics

Diagnostics that depend on the user doing something during a time window, especially audio recording, must be coordinated explicitly. Talkd/Pi should announce attention is required, get readiness, show a visible action/timing banner when possible, give a spoken countdown, and only then start the window. Silence, low audio, or bad transcription is inconclusive unless the user was clearly prompted and acknowledged readiness.

### Incremental speech synthesis

Talkd streams assistant text into TTS incrementally, but buffers larger natural chunks before synthesis to avoid choppy playback. It prefers complete sentence boundaries and otherwise waits for a reasonable threshold before flushing.

Tuning knobs:

- `TALKD_STREAMING_TTS_MIN_CHARS` — minimum chunk size before a natural flush; default `110`.
- `TALKD_STREAMING_TTS_MIN_WORDS` — word-count threshold for a natural flush; default `16`.
- `TALKD_STREAMING_TTS_CHUNK_CHARS` — fallback maximum chunk size when no sentence boundary arrives; default `280`.

Barge-in behavior is preserved: pressing F12 during thinking, TTS generation, or playback interrupts the side-agent/playback and starts a new recording turn.

## Notes

- Main Pi responses are not read aloud by default.
- Spoken replies come from Talkd, not from the main coding agent transcript.
- `talkd-service` is shared and reused across Pi sessions.
