import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { playPCMAsWav, startRecording, type PlaybackHandle, type RecordingHandle } from "./audio";
import { isVoiceDebugUIEnabled, stripAnsi, voiceDebugLog, voiceLatencyLog } from "./debug";
import { limitPlainSpeech, makeConversationalSummary, toPlainSpeechText } from "./speech-text";
import { TalkdClient } from "./talkd-client";
import { VoiceAgent } from "./voice-agent";

type State = "idle" | "listening" | "transcribing" | "thinking" | "speaking" | "error";
type PiCtx = ExtensionContext;
type TimingDetails = Record<string, string | number | boolean | undefined>;

export interface VoiceControllerOptions {
  agent: VoiceAgent;
  ensureService?(): Promise<void>;
}

export class VoiceController {
  private state: State = "idle";
  private recorder?: RecordingHandle;
  private playback?: PlaybackHandle;
  private speechQueue?: IncrementalSpeechQueue;
  private lastCtx?: PiCtx;
  private harnessTimer?: ReturnType<typeof setTimeout>;
  private idleReactionTimer?: ReturnType<typeof setTimeout>;
  private recordingLimitTimer?: ReturnType<typeof setTimeout>;
  private recordingReleaseTimer?: ReturnType<typeof setTimeout>;
  private lastRecordingShortcutAt = 0;
  private lastHarnessChange = "";
  private pendingSkippedHarnessChange = "";
  private lastSpokenAt = 0;
  private nextTimingId = 1;
  private runSerial = 0;
  private readonly client = new TalkdClient(process.env.TALKD_SOCK ?? join(homedir(), ".talkd", "talkd.sock"));

  constructor(private readonly options: VoiceControllerOptions) {}

  attach(ctx: PiCtx) {
    this.lastCtx = ctx;
    this.renderStatus(ctx);
  }

  async toggle(ctx: PiCtx): Promise<void> {
    this.attach(ctx);

    if (this.state === "speaking") {
      this.speechQueue?.cancel();
      this.playback?.stop();
      this.playback = undefined;
      if (this.options.agent.isBusy()) await this.options.agent.abort();
      this.startRecordingTurn(ctx, "Talkd: interrupted — recording active");
      return;
    }

    if (this.state === "thinking" || this.options.agent.isBusy()) {
      this.speechQueue?.cancel();
      await this.options.agent.abort();
      this.startRecordingTurn(ctx, "Talkd: interrupted — recording active");
      return;
    }

    if (this.state === "transcribing") {
      this.startRecordingTurn(ctx, "Talkd: recording active");
      return;
    }

    if (this.state === "listening") {
      await this.handleRecordingShortcut(ctx);
      return;
    }

    this.startRecordingTurn(ctx);
  }

  onHarnessEvent(change: string, ctx: PiCtx) {
    this.attach(ctx);
    this.lastHarnessChange = change;

    // Do not run proactive side-agent checks while the user is interacting,
    // while Talkd is already doing work, or while the main harness is actively
    // generating. If the harness is still generating, remember the latest change
    // and retry once the harness becomes idle so completion updates are not lost.
    if (!ctx.isIdle()) {
      this.rememberSkippedHarnessChange(change, ctx, "harness_busy");
      return;
    }
    if (!this.canRunProactiveUpdate(ctx)) {
      this.rememberSkippedHarnessChange(change, ctx, "talkd_busy");
      return;
    }

    this.scheduleHarnessReaction();
  }

  cleanup() {
    this.recorder?.stop();
    this.recorder = undefined;
    this.speechQueue?.cancel();
    this.speechQueue = undefined;
    this.playback?.stop();
    this.playback = undefined;
    if (this.harnessTimer) clearTimeout(this.harnessTimer);
    this.harnessTimer = undefined;
    if (this.idleReactionTimer) clearTimeout(this.idleReactionTimer);
    this.idleReactionTimer = undefined;
    this.clearRecordingLimitTimer();
    this.clearRecordingReleaseTimer();
    this.options.agent.dispose();
    if (this.lastCtx) this.clearWidget(this.lastCtx);
  }

  private startRecordingTurn(ctx: PiCtx, message = "Talkd: recording active — F12 sends") {
    this.runSerial++;
    if (this.harnessTimer) clearTimeout(this.harnessTimer);
    this.harnessTimer = undefined;
    this.clearRecordingLimitTimer();
    this.recorder?.stop();
    this.speechQueue?.cancel();
    this.speechQueue = undefined;
    this.playback?.stop();
    this.playback = undefined;
    this.lastRecordingShortcutAt = Date.now();
    this.recorder = startRecording(16000);
    this.setState("listening", ctx, message);
    this.scheduleRecordingLimit(ctx);
  }

  private async handleRecordingShortcut(ctx: PiCtx) {
    const now = Date.now();
    const repeatGapMs = readNumberEnv("TALKD_RECORDING_KEY_REPEAT_GAP_MS", 900);
    const gapMs = now - this.lastRecordingShortcutAt;
    this.lastRecordingShortcutAt = now;

    if (gapMs <= repeatGapMs) {
      this.scheduleRecordingReleaseInference(ctx, repeatGapMs);
      voiceLatencyLog("recording.shortcut_repeat_ignored", { gapMs, repeatGapMs });
      return;
    }

    await this.stopAndDiscuss(ctx);
  }

  private scheduleRecordingReleaseInference(ctx: PiCtx, repeatGapMs: number) {
    this.clearRecordingReleaseTimer();
    this.recordingReleaseTimer = setTimeout(() => {
      if (this.state !== "listening" || !this.recorder) return;
      voiceLatencyLog("recording.release_inferred", { repeatGapMs });
      void this.stopAndDiscuss(ctx);
    }, repeatGapMs);
  }

  private scheduleRecordingLimit(ctx: PiCtx) {
    const maxMs = readNumberEnv("TALKD_PUSH_TO_TALK_MAX_MS", 120_000);
    this.recordingLimitTimer = setTimeout(() => {
      if (this.state !== "listening" || !this.recorder) return;
      voiceLatencyLog("recording.max_duration", { maxMs });
      this.setState("listening", ctx, "Talkd: recording limit reached — sending");
      void this.stopAndDiscuss(ctx);
    }, maxMs);
  }

  private clearRecordingLimitTimer() {
    if (this.recordingLimitTimer) clearTimeout(this.recordingLimitTimer);
    this.recordingLimitTimer = undefined;
  }

  private clearRecordingReleaseTimer() {
    if (this.recordingReleaseTimer) clearTimeout(this.recordingReleaseTimer);
    this.recordingReleaseTimer = undefined;
  }

  private async stopAndDiscuss(ctx: PiCtx) {
    const recorder = this.recorder;
    if (!recorder) return;

    this.clearRecordingLimitTimer();
    this.clearRecordingReleaseTimer();
    const runId = ++this.runSerial;
    const turnId = this.nextTimingId++;
    const totalStart = nowMs();
    this.recorder = undefined;
    recorder.stop();
    this.setState("transcribing", ctx, "Talkd: transcribing...");

    try {
      const recordingStart = nowMs();
      const pcm = await recorder.done;
      if (!this.isCurrentRun(runId)) return;
      this.logTiming("recording_finalize", recordingStart, { turnId, bytes: pcm.length, audioSeconds: audioSeconds(pcm, recorder.sampleRate) });
      if (pcm.length < 3200) {
        this.logTiming("pipeline_too_little_audio", totalStart, { turnId });
        this.setState("idle", ctx);
        ctx.ui.notify?.("Too little audio. Try again.", "warning");
        return;
      }

      this.setState("transcribing", ctx, "Talkd: starting audio service...");
      await this.options.ensureService?.();
      if (!this.isCurrentRun(runId)) return;

      const sttStart = nowMs();
      const transcript = await this.client.sttPCM(pcm, recorder.sampleRate);
      if (!this.isCurrentRun(runId)) return;
      this.logTiming("stt", sttStart, { turnId, transcriptChars: transcript.length, transcriptWords: countWords(transcript) });
      voiceDebugLog("transcript", { turnId, text: transcript });
      if (!transcript.trim()) {
        this.logTiming("pipeline_no_speech", totalStart, { turnId });
        this.setState("idle", ctx);
        ctx.ui.notify?.("No speech detected. Try again.", "warning");
        return;
      }

      this.setState("thinking", ctx, "Talkd: thinking");
      const agentStart = nowMs();
      const speakStart = nowMs();
      const reply = await this.askAndSpeakStreaming(transcript, ctx, turnId);
      if (!this.isCurrentRun(runId)) return;
      this.logTiming("voice_agent", agentStart, { turnId, replyChars: reply.length });
      this.logTiming("speak_stream_total", speakStart, { turnId });
      this.logTiming("pipeline_total", totalStart, { turnId });
    } catch (error) {
      if (!this.isCurrentRun(runId)) return;
      this.logTiming("pipeline_error", totalStart, { turnId });
      this.setState("error", ctx, error instanceof Error ? error.message : String(error));
    }
  }

  private rememberSkippedHarnessChange(change: string, ctx: PiCtx, reason: "harness_busy" | "talkd_busy") {
    this.pendingSkippedHarnessChange = change;
    this.lastHarnessChange = change;
    voiceLatencyLog("proactive.skipped", { reason, harnessIdle: ctx.isIdle(), state: this.state });
    this.scheduleIdleReaction();
  }

  private scheduleHarnessReaction() {
    if (this.harnessTimer) clearTimeout(this.harnessTimer);
    const delay = readNumberEnv("TALKD_HARNESS_REACT_DELAY_MS", 750);
    this.harnessTimer = setTimeout(() => void this.reactToHarnessChange(), delay);
  }

  private scheduleIdleReaction() {
    if (this.idleReactionTimer) return;
    const delay = readNumberEnv("TALKD_HARNESS_IDLE_REACT_POLL_MS", 1000);
    this.idleReactionTimer = setTimeout(() => {
      this.idleReactionTimer = undefined;
      void this.reactToHarnessChange();
    }, delay);
  }

  private canRunProactiveUpdate(ctx: PiCtx): boolean {
    return ctx.isIdle() && this.state !== "listening" && this.state !== "transcribing" && this.state !== "thinking" && this.state !== "speaking" && !this.options.agent.isBusy();
  }

  private async reactToHarnessChange() {
    const ctx = this.lastCtx;
    if (!ctx) return;
    if (!this.canRunProactiveUpdate(ctx)) {
      if (this.pendingSkippedHarnessChange || !ctx.isIdle()) this.scheduleIdleReaction();
      return;
    }
    const minGap = readNumberEnv("TALKD_MIN_PROACTIVE_GAP_MS", 10_000);
    if (Date.now() - this.lastSpokenAt < minGap) {
      if (this.pendingSkippedHarnessChange) this.scheduleIdleReaction();
      return;
    }

    if (this.pendingSkippedHarnessChange) {
      this.lastHarnessChange = this.pendingSkippedHarnessChange;
      this.pendingSkippedHarnessChange = "";
      voiceLatencyLog("proactive.resuming_skipped", { changeChars: this.lastHarnessChange.length });
    }

    const turnId = this.nextTimingId++;
    const totalStart = nowMs();
    try {
      this.setState("thinking", ctx, "Talkd: checking update");
      const agentStart = nowMs();
      const reply = await this.options.agent.observeHarnessChange(this.lastHarnessChange, ctx);
      this.logTiming("proactive_voice_agent", agentStart, { turnId, replyChars: reply.length });
      if (isSilence(reply)) {
        this.logTiming("proactive_silence_total", totalStart, { turnId });
        this.setState("idle", ctx);
        return;
      }
      const speakStart = nowMs();
      await this.speak(reply, ctx, turnId, readNumberEnv("TALKD_PROACTIVE_SPOKEN_MAX_CHARS", 100));
      this.logTiming("proactive_speak_total", speakStart, { turnId });
      this.logTiming("proactive_total", totalStart, { turnId });
    } catch (error) {
      this.logTiming("proactive_error", totalStart, { turnId });
      this.setState("error", ctx, error instanceof Error ? error.message : String(error));
    }
  }

  private async askAndSpeakStreaming(transcript: string, ctx: PiCtx, turnId: number): Promise<string> {
    let queue!: IncrementalSpeechQueue;
    queue = new IncrementalSpeechQueue(
      (chunk) => this.speakStreamingChunk(chunk, ctx, turnId, queue),
      (label, fields = {}) => voiceLatencyLog(`streaming_tts_queue.${label}`, { turnId, ...fields }),
      { maxSpokenChars: readNumberEnv("TALKD_SPOKEN_REPLY_MAX_CHARS", 140) },
    );
    queue.done.catch(() => undefined);
    this.speechQueue = queue;
    voiceDebugLog("streaming_speech", { turnId, enabled: true, transcriptChars: transcript.length });
    voiceLatencyLog("prompt.streaming_start", { turnId, transcriptChars: transcript.length, transcriptWords: countWords(transcript) });
    const watchdog = this.startThinkingWatchdog(ctx, turnId, transcript.length);
    const promptStart = nowMs();
    let firstDelta = true;
    try {
      const reply = await this.withAgentTimeout(
        this.options.agent.askStreaming(transcript, ctx, (delta) => {
          if (firstDelta) {
            firstDelta = false;
            this.logTiming("prompt_first_delta", promptStart, { turnId, deltaChars: delta.length });
          }
          queue.addDelta(delta);
        }),
        ctx,
        queue,
        turnId,
      );
      watchdog.stop();
      voiceLatencyLog("prompt.streaming_end", { turnId, replyChars: reply.length, replyWords: countWords(reply), queuedChunks: queue.enqueuedChunks, playedChunks: queue.playedChunks });
      queue.finish();
      await queue.done;
      if (!queue.cancelled && queue.playedChunks === 0 && !isSilence(reply)) {
        await this.speak(reply, ctx, turnId, readNumberEnv("TALKD_SPOKEN_REPLY_MAX_CHARS", 140));
      } else if (!queue.cancelled && this.speechQueue === queue) {
        this.setState("idle", ctx, "Talkd: done");
      }
      return reply;
    } finally {
      watchdog.stop();
      if (this.speechQueue === queue) this.speechQueue = undefined;
    }
  }

  private startThinkingWatchdog(ctx: PiCtx, turnId: number, transcriptChars: number): { stop(): void } {
    const start = Date.now();
    const firstNoticeMs = readNumberEnv("TALKD_VOICE_THINKING_NOTICE_MS", 12_000);
    const intervalMs = readNumberEnv("TALKD_VOICE_THINKING_NOTICE_INTERVAL_MS", 10_000);
    let stopped = false;
    let interval: ReturnType<typeof setInterval> | undefined;
    const show = () => {
      if (stopped || this.state !== "thinking") return;
      const elapsedSeconds = Math.max(1, Math.round((Date.now() - start) / 1000));
      this.setState("thinking", ctx, `Talkd: thinking ${elapsedSeconds}s — F12 interrupts`);
      voiceLatencyLog("watchdog.notice", { turnId, elapsedSeconds, transcriptChars });
    };
    const timeout = setTimeout(() => {
      show();
      interval = setInterval(show, intervalMs);
    }, firstNoticeMs);
    return {
      stop() {
        stopped = true;
        clearTimeout(timeout);
        if (interval) clearInterval(interval);
      },
    };
  }

  private async withAgentTimeout<T>(promise: Promise<T>, ctx: PiCtx, queue: IncrementalSpeechQueue, turnId: number): Promise<T> {
    const timeoutMs = readNumberEnv("TALKD_VOICE_AGENT_TIMEOUT_MS", 120_000);
    if (timeoutMs <= 0) return promise;

    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            voiceLatencyLog("watchdog.timeout", { turnId, timeoutMs });
            queue.cancel();
            void this.options.agent.abort();
            this.setState("error", ctx, "Talkd: side-agent timed out — press F12 to try again");
            reject(new Error(`Talkd side-agent timed out after ${Math.round(timeoutMs / 1000)}s`));
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private async speakStreamingChunk(text: string, ctx: PiCtx, turnId: number, queue: IncrementalSpeechQueue): Promise<void> {
    const spoken = cleanSpeechChunk(text);
    if (!spoken || isSilence(spoken) || queue.cancelled) return;

    voiceDebugLog("streaming_speech.chunk", { turnId, text: spoken });
    this.setState("thinking", ctx, "Talkd: preparing reply");
    const ttsStart = nowMs();
    voiceLatencyLog("tts.chunk_synthesis_start", { turnId, chars: spoken.length, words: countWords(spoken) });
    const { pcm, sampleRate } = await this.client.ttsPCM(spoken);
    this.logTiming("tts_stream_chunk", ttsStart, { turnId, chars: spoken.length, words: countWords(spoken), bytes: pcm.length, sampleRate });
    if (queue.cancelled) return;

    this.setState("speaking", ctx, "Talkd: speaking — F12 interrupts");
    const playbackStart = nowMs();
    const playback = await playPCMAsWav(pcm, sampleRate);
    this.logTiming("playback_stream_start", playbackStart, { turnId });
    if (queue.cancelled) {
      playback.stop();
      return;
    }

    this.playback = playback;
    this.lastSpokenAt = Date.now();
    await playback.done;
    this.logTiming("playback_stream_chunk", playbackStart, { turnId, chars: spoken.length, audioBytes: pcm.length });
    if (this.playback === playback) this.playback = undefined;
    if (!queue.cancelled) this.setState("thinking", ctx, "Talkd: thinking");
  }

  private async speak(text: string, ctx: PiCtx, turnId?: number, maxChars = readNumberEnv("TALKD_SPOKEN_REPLY_MAX_CHARS", 140)): Promise<void> {
    const summaryStart = nowMs();
    const spoken = text.trim() ? makeConversationalSummary(text, maxChars).trim() : "";
    this.logTiming("speech_summary", summaryStart, { turnId, inputChars: text.length, spokenChars: spoken.length, maxChars });
    voiceDebugLog("spoken_summary", { turnId, text: spoken });
    if (!spoken || isSilence(spoken)) {
      this.setState("idle", ctx);
      return;
    }

    this.setState("thinking", ctx, "Talkd: starting audio service...");
    await this.options.ensureService?.();

    this.setState("thinking", ctx, "Talkd: preparing reply");
    const ttsStart = nowMs();
    voiceLatencyLog("tts.full_synthesis_start", { turnId, chars: spoken.length, words: countWords(spoken) });
    const { pcm, sampleRate } = await this.client.ttsPCM(spoken);
    this.logTiming("tts", ttsStart, { turnId, chars: spoken.length, words: countWords(spoken), bytes: pcm.length, sampleRate });
    this.setState("speaking", ctx, "Talkd: speaking — F12 interrupts");
    const playbackStart = nowMs();
    const playback = await playPCMAsWav(pcm, sampleRate);
    this.logTiming("playback_start", playbackStart, { turnId });
    this.playback = playback;
    this.lastSpokenAt = Date.now();
    await playback.done;
    this.logTiming("playback", playbackStart, { turnId, chars: spoken.length, audioBytes: pcm.length });
    if (this.playback === playback) {
      this.playback = undefined;
      this.setState("idle", ctx, "Talkd: done");
    }
  }

  private isCurrentRun(runId: number): boolean {
    return this.runSerial === runId;
  }

  private setState(state: State, ctx: PiCtx, detail?: string) {
    this.state = state;
    voiceDebugLog("state", { state, detail });
    this.renderStatus(ctx, detail);
  }

  private renderStatus(ctx: PiCtx, detail?: string) {
    const theme = ctx.ui.theme;
    const indicator = voiceIndicator(this.state, detail);

    // Keep one persistent Talkd indicator visible across idle/done/active
    // states. Use the below-editor widget as the single visible surface and
    // leave footer status empty to avoid duplicate rendering.
    ctx.ui.setStatus("talkd-voice", undefined);
    const label = indicator.widget(theme);
    const debug = isVoiceDebugUIEnabled() && detail ? theme.fg("dim", `  ·  ${compactForWidget(detail, 80)}`) : "";
    ctx.ui.setWidget?.("talkd-voice", [label + debug], { placement: "belowEditor" });
  }

  private clearWidget(ctx: PiCtx) {
    ctx.ui.setWidget?.("talkd-voice", undefined);
  }

  private logTiming(label: string, startedAt: number, details: TimingDetails = {}) {
    const elapsedMs = Math.max(0, Math.round(nowMs() - startedAt));
    voiceLatencyLog(`timing.${label}`, { ms: elapsedMs, ...details });
  }
}

class IncrementalSpeechQueue {
  private buffer = "";
  private chunks: string[] = [];
  private pumping = false;
  private finished = false;
  playedChunks = 0;
  enqueuedChunks = 0;
  private resolveDone!: () => void;
  private rejectDone!: (error: unknown) => void;
  cancelled = false;
  readonly done = new Promise<void>((resolve, reject) => {
    this.resolveDone = resolve;
    this.rejectDone = reject;
  });

  private spokenChars = 0;

  constructor(
    private readonly onChunk: (chunk: string) => Promise<void>,
    private readonly log: (label: string, fields?: TimingDetails) => void = () => undefined,
    private readonly options: { maxSpokenChars?: number } = {},
  ) {}

  addDelta(delta: string) {
    if (this.cancelled || this.finished || !delta) return;
    this.buffer += delta;
    this.log("delta", { deltaChars: delta.length, bufferChars: this.buffer.length });
    for (;;) {
      const beforeChars = this.buffer.length;
      const next = takeReadySpeechChunk(this.buffer, this.enqueuedChunks);
      if (!next) break;
      this.buffer = next.rest;
      this.log("flush_ready", { chunkChars: next.chunk.length, restChars: next.rest.length, beforeChars });
      this.enqueue(next.chunk);
    }
  }

  finish() {
    if (this.cancelled || this.finished) return;
    const final = cleanSpeechChunk(this.buffer);
    this.log("finish", { finalChars: final.length, bufferedChars: this.buffer.length, queuedChunks: this.chunks.length });
    this.buffer = "";
    if (final) this.enqueue(final);
    this.finished = true;
    this.pump();
    this.resolveIfDone();
  }

  cancel() {
    if (this.cancelled) return;
    this.cancelled = true;
    this.log("cancel", { bufferedChars: this.buffer.length, queuedChunks: this.chunks.length, playedChunks: this.playedChunks });
    this.buffer = "";
    this.chunks = [];
    this.resolveDone();
  }

  private enqueue(chunk: string) {
    let cleaned = cleanSpeechChunk(chunk);
    if (!cleaned || isSilence(cleaned)) return;

    const maxSpokenChars = this.options.maxSpokenChars;
    if (maxSpokenChars && maxSpokenChars > 0) {
      const remaining = maxSpokenChars - this.spokenChars;
      if (remaining < 20) {
        this.log("drop_over_cap", { chunkChars: cleaned.length, maxSpokenChars, spokenChars: this.spokenChars, remaining });
        return;
      }
      if (cleaned.length > remaining) {
        const beforeChars = cleaned.length;
        cleaned = limitPlainSpeech(cleaned, remaining).trim();
        this.log("truncate_to_cap", { beforeChars, chunkChars: cleaned.length, maxSpokenChars, spokenChars: this.spokenChars });
      }
    }

    if (!cleaned || isSilence(cleaned)) return;
    this.spokenChars += cleaned.length;
    this.chunks.push(cleaned);
    this.enqueuedChunks++;
    this.log("enqueue", { chunkChars: cleaned.length, chunkWords: countWords(cleaned), queuedChunks: this.chunks.length, enqueuedChunks: this.enqueuedChunks, spokenChars: this.spokenChars, maxSpokenChars });
    this.pump();
  }

  private pump() {
    if (this.pumping || this.cancelled) return;
    this.pumping = true;
    void (async () => {
      try {
        while (!this.cancelled && this.chunks.length > 0) {
          const chunk = this.chunks.shift();
          if (chunk) {
            this.log("play_start", { chunkChars: chunk.length, queuedChunks: this.chunks.length });
            await this.onChunk(chunk);
            this.playedChunks++;
            this.log("play_end", { playedChunks: this.playedChunks, queuedChunks: this.chunks.length });
          }
        }
        this.pumping = false;
        this.resolveIfDone();
      } catch (error) {
        this.pumping = false;
        if (this.cancelled) this.resolveDone();
        else this.rejectDone(error);
      }
    })();
  }

  private resolveIfDone() {
    if (this.finished && !this.pumping && this.chunks.length === 0) this.resolveDone();
  }
}

function takeReadySpeechChunk(buffer: string, enqueuedChunks: number): { chunk: string; rest: string } | undefined {
  const normalized = buffer.replace(/\s+/g, " ");
  const firstChunk = enqueuedChunks === 0;
  const minChars = firstChunk
    ? readNumberEnv("TALKD_STREAMING_TTS_FIRST_MIN_CHARS", 80)
    : readNumberEnv("TALKD_STREAMING_TTS_MIN_CHARS", 110);
  const minWords = firstChunk
    ? readNumberEnv("TALKD_STREAMING_TTS_FIRST_MIN_WORDS", 10)
    : readNumberEnv("TALKD_STREAMING_TTS_MIN_WORDS", 16);
  if (!isSubstantialSpeechChunk(normalized, minChars, minWords)) return undefined;

  const sentence = /[.!?]+(?:["')\]]+)?(?=\s|$)/g;
  let match: RegExpExecArray | null;
  while ((match = sentence.exec(normalized))) {
    const end = match.index + match[0].length;
    const candidate = normalized.slice(0, end);
    if (isSubstantialSpeechChunk(candidate, minChars, minWords)) {
      const restStart = normalized.slice(end).match(/^\s*/)?.[0].length ?? 0;
      return { chunk: candidate, rest: normalized.slice(end + restStart) };
    }
  }

  const maxChars = firstChunk
    ? readNumberEnv("TALKD_STREAMING_TTS_FIRST_CHUNK_CHARS", 180)
    : readNumberEnv("TALKD_STREAMING_TTS_CHUNK_CHARS", 280);
  if (normalized.length < maxChars) return undefined;
  const softBreak = Math.max(
    normalized.lastIndexOf(". ", maxChars),
    normalized.lastIndexOf("? ", maxChars),
    normalized.lastIndexOf("! ", maxChars),
    normalized.lastIndexOf(", ", maxChars),
    normalized.lastIndexOf("; ", maxChars),
    normalized.lastIndexOf(": ", maxChars),
    normalized.lastIndexOf(" — ", maxChars),
  );
  const hardBreak = normalized.lastIndexOf(" ", maxChars);
  const minimumSplit = Math.max(minChars, 120);
  const splitAt = softBreak > minimumSplit ? softBreak + 2 : hardBreak > minimumSplit ? hardBreak + 1 : maxChars;
  return { chunk: normalized.slice(0, splitAt), rest: normalized.slice(splitAt) };
}

function isSubstantialSpeechChunk(text: string, minChars: number, minWords: number): boolean {
  const trimmed = text.trim();
  if (trimmed.length >= minChars) return true;
  return trimmed.split(/\s+/).filter(Boolean).length >= minWords;
}

function cleanSpeechChunk(text: string): string {
  return toPlainSpeechText(text).trim();
}

function voiceIndicator(state: State, detail?: string): { widget(theme: PiCtx["ui"]["theme"]): string } {
  const interrupted = /interrupted/i.test(detail ?? "");
  if (state === "listening") {
    return {
      widget: (theme) => theme.fg("accent", interrupted ? "[REC] Talkd: interrupted, recording" : "[REC] Talkd: recording active") + theme.fg("dim", " — mic is on now. Release F12 to send, or press F12 again."),
    };
  }
  if (state === "transcribing") {
    return {
      widget: (theme) => theme.fg("warning", "[STT] Talkd: transcribing") + theme.fg("dim", " — converting your speech to text."),
    };
  }
  if (state === "thinking") {
    const preparingSpeech = /speech|tts|prepar/i.test(detail ?? "");
    return {
      widget: (theme) => theme.fg("warning", preparingSpeech ? "[TTS] Talkd: preparing reply" : "[THINK] Talkd: thinking") + theme.fg("dim", preparingSpeech ? " — generating the spoken response." : " — assistant is thinking."),
    };
  }
  if (state === "speaking") {
    return {
      widget: (theme) => theme.fg("success", "[PLAY] Talkd: speaking") + theme.fg("dim", " — press F12 to interrupt/barge in."),
    };
  }
  if (state === "error") {
    const message = detail ? ` — ${compactForWidget(detail, 100)}` : "";
    return {
      widget: (theme) => theme.fg("error", "[ERR] Talkd: error") + theme.fg("dim", message),
    };
  }
  const done = /done|complete|finished/i.test(detail ?? "");
  return {
    widget: (theme) => theme.fg("dim", done ? "[DONE] Talkd: done — press F12 to record." : "[READY] Talkd: ready — press F12 to record."),
  };
}

function compactForWidget(text: string, max = 140): string {
  const normalized = stripAnsi(text).replace(/\s+/g, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

function readNumberEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function nowMs(): number {
  return Date.now();
}

function audioSeconds(pcm: Buffer, sampleRate: number): number {
  return Math.round((pcm.length / 2 / sampleRate) * 100) / 100;
}

function countWords(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

function isSilence(text: string): boolean {
  return /^\s*(silence|no response|nothing)\s*\.?\s*$/i.test(text);
}
