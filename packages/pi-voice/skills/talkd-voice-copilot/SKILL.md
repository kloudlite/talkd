---
name: talkd-voice-copilot
description: Guidance for implementing, reviewing, or tuning the Talkd Pi voice copilot. Use when working on Talkd spoken interaction, side-agent behavior, latency, proactive updates, TTS/STT streaming, local fast paths, or read-only coordination with the main Pi harness.
---

# Talkd Voice Copilot

Use this skill when changing or reviewing `packages/pi-voice` behavior for Talkd spoken interaction in Pi. The actual runtime side-agent skill lives in `side-agent-skills/talkd-side-agent-voice-copilot/SKILL.md` and is activated in the hidden Talkd side-agent context; keep this maintainer skill aligned with that runtime skill.

## Core Architecture

- Keep Talkd as a lightweight side-agent. Do not reintroduce full main-session cloning/forking by default.
- The Talkd side-agent gets main harness context from:
  - the current harness snapshot embedded in the prompt,
  - the `get_harness_state` coordination tool,
  - recent observed harness events and branch summaries,
  - Talkd's persisted recent voice state.
- Preserve `noSkills: true` in the side-agent `DefaultResourceLoader`; Talkd should not load Pi skills dynamically at runtime.
- Put runtime speaking/watching behavior in `side-agent-skills/talkd-side-agent-voice-copilot/SKILL.md` and activate it in hidden side-agent context, not only in this development skill.
- Preserve read-only/coordination-only behavior. Talkd must not receive direct file, shell, edit, write, or coding tools.

## Runtime Spoken and Watching Behavior

The Talkd side-agent itself must receive this behavior through `side-agent-skills/talkd-side-agent-voice-copilot/SKILL.md`:

- Prefer brief, natural replies suitable for audio playback.
- Default to one concise sentence. Avoid markdown, bullets, code, long enumerations, and multi-part guessed alternatives unless the user explicitly asks.
- If STT/transcript looks garbled or low-confidence, ask the user to repeat it.
- Do not read main assistant messages verbatim. Summarize the useful state instead.
- Watch lightweight harness/session signals: idle/busy, recent events, active tools, context usage, editor text, branch summary, and user requests to watch completion/failure.
- Use `get_harness_state` when the snapshot is stale or the user asks what is happening; keep the spoken answer short.
- Use Talkd product naming in visible UI/status text.
- Avoid generic visible “voice” wording where possible, and avoid emoji/dot-style status indicators.

## Active Pi Session Inspection

When the user asks Talkd or the main Pi agent to “read”, “inspect”, or “check” the existing active Pi session, prefer the lowest-latency context source that answers the question. Do not solve this by prepending or cloning the full main session into the Talkd runtime side-agent.

Recommended order:

1. **Use Talkd's harness snapshot path.** The runtime `get_harness_state` coordination tool returns the current visible harness snapshot, recent observed events, editor text, and a short branch summary. This is the normal way for Talkd to answer status/context questions.
2. **Use the active main Pi conversation context already available to the main coding agent only when this development skill is loaded in the main harness.** Do not assume the Talkd runtime side-agent has that full context.
3. **Use Pi session metadata and summaries when maintaining the extension.** Extension code can inspect read-only session state through `ctx.sessionManager`:
   - `ctx.sessionManager.getBranch()` — current active branch entries.
   - `ctx.sessionManager.getEntries()` — all entries in the session file.
   - `ctx.sessionManager.getLeafId()` / `getLeafEntry()` — current active position.
   - `ctx.sessionManager.getSessionFile()` — JSONL session path, if persisted.
   - `ctx.getContextUsage()` — current context-window usage.
   - `ctx.sessionManager.buildSessionContext()` or exported `buildSessionContext(...)` — resolved LLM context, including compaction and branch summaries. Use only for targeted diagnostics/maintenance, not as Talkd's normal runtime prompt prefix.
4. **Inspect persisted files only when explicitly requested.** If the user asks for log/session forensics, read targeted ranges/tails of the JSONL session file or debug log and summarize. Avoid loading or injecting the full transcript into Talkd.

Useful existing summary mechanisms:

- Pi `compaction` entries store summaries of older context.
- Pi `branch_summary` entries store summaries created during `/tree` navigation.
- Talkd already exposes a compact branch summary in `HarnessWatcher.snapshot()` via `summarizeBranch(...)`; keep this summary short and recent.

Do not:

- Reintroduce `SessionManager.forkFrom(...)` or full-session clone/fork behavior into `packages/pi-voice/src/voice-agent.ts` by default.
- Append the full active main Pi transcript to every Talkd side-agent prompt.
- Give the Talkd side-agent direct file, shell, edit, or write tools just to inspect the session.
- Let session inspection override the brief spoken-response contract; inspect first, then speak a short summary.

If Talkd cannot answer from snapshot/recent events, it should use `get_harness_state` once, ask a brief clarification, or send a concise coordination request to the main harness, depending on the user's intent.

## Local Fast Paths

For safe simple check-ins, prefer local fast paths that avoid the model entirely:

- greetings/presence checks: “are you there”, “can you hear me”, “testing”
- acknowledgements: “thanks”, “got it”, “never mind”
- status checks: “status”, “what’s happening”, “what’s Pi doing”
- completion checks: “is it done”, “did it finish”

Fast replies may use only the current harness snapshot and recent events. They must not infer hidden facts or perform work. Record the Talkd turn in recent state and log `latency.local_fast_reply`.

## Proactive Updates

- Stay silent for routine progress and ordinary tool output.
- Speak only when useful: task finished, failed, needs user attention, or an important surprising state change occurred.
- Keep proactive updates very short, ideally under `TALKD_PROACTIVE_SPOKEN_MAX_CHARS`.
- Preserve skipped-update retry when the main harness or Talkd is busy.

## Streaming, TTS, and Barge-In

- Start TTS on the first useful complete sentence/chunk rather than waiting for long output.
- Keep normal spoken output capped with `TALKD_SPOKEN_REPLY_MAX_CHARS`.
- Preserve incremental TTS queueing, serial playback, cancellation, and F12 barge-in/interruption.
- Do not optimize by sacrificing interruption responsiveness.

## Latency Diagnostics

When tuning latency, enable and inspect:

```bash
export TALKD_VOICE_LATENCY_DEBUG=1
export TALKD_VOICE_DEBUG_LOG=/tmp/talkd-pi-voice-debug.log
```

Important markers:

- `latency.session.lightweight` confirms the lightweight side-agent path.
- Absence of `latency.session.in_memory_clone` and `latency.session.persisted_full_fork` after reload confirms full-session cloning/forking was not reintroduced.
- `latency.local_fast_reply` confirms a model-bypassing check-in path.
- `latency.prompt.first_text_delta` and `latency.timing.prompt_first_delta` measure model first-token delay.
- `latency.timing.tts_stream_chunk` measures TTS synthesis.
- `latency.timing.playback_stream_chunk` and `latency.timing.playback` measure audio playback duration.
- `latency.proactive.skipped` and `latency.proactive.resuming_skipped` verify proactive retry behavior.

## Files to Review

- `packages/pi-voice/side-agent-skills/talkd-side-agent-voice-copilot/SKILL.md` — runtime side-agent skill activated in Talkd's hidden context.
- `packages/pi-voice/src/side-agent-skill.ts` — loader for the explicit side-agent skill.
- `packages/pi-voice/src/voice-agent.ts` — side-agent prompts, tools, local fast paths, recent state, session creation.
- `packages/pi-voice/src/voice-controller.ts` — recording/STT pipeline, streaming TTS queue, playback, proactive retry, barge-in.
- `packages/pi-voice/src/audio.ts` — playback process lifecycle and interruption.
- `packages/pi-voice/src/speech-text.ts` — spoken text cleanup and length caps.
- `packages/pi-voice/src/debug.ts` — diagnostics and latency logging.

## Validation

After changing Talkd code, run:

```bash
cd packages/pi-voice && bun run check && bun run build
```

Then ask the user to run `/reload` in Pi or restart Pi.
