import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  type AgentSession,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionEntry,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

type AgentMessage = { role?: string; content?: unknown };
import { Type } from "typebox";
import { voiceLatencyLog } from "./debug";
import { loadTalkdSideAgentSkill, talkdSideAgentSkillPath } from "./side-agent-skill";

const CUSTOM_TYPE = "talkd.voice";
const SIDE_AGENT_INSTRUCTIONS_TYPE = "talkd.side_agent_instructions";
const RECENT_CONTEXT_TYPE = "talkd.recent_voice_context";
const PROACTIVE_DECISION_TYPE = "talkd.proactive_decision";
const SIDE_AGENT_SKILL_TYPE = "talkd.side_agent_skill";
const MAX_OBSERVED_EVENTS = 80;
const VOICE_TOOL_NAMES = ["get_harness_state", "send_to_harness", "add_harness_note"];

export interface HarnessSnapshot {
  cwd: string;
  model: string;
  idle: boolean;
  contextUsage?: string;
  activeTools: string[];
  currentEditorText?: string;
  recentEvents: string[];
  branch: string;
}

export interface VoiceHarnessContext {
  ctx: ExtensionContext;
  pi: ExtensionAPI;
}

export class HarnessWatcher {
  private events: string[] = [];
  private lastCtx?: ExtensionContext;

  attach(ctx: ExtensionContext) {
    this.lastCtx = ctx;
  }

  record(line: string) {
    const trimmed = line.replace(/\s+/g, " ").trim();
    if (!trimmed) return;
    this.events.push(`${new Date().toISOString().slice(11, 19)} ${trimmed}`);
    this.events = this.events.slice(-MAX_OBSERVED_EVENTS);
  }

  snapshot(ctx = this.lastCtx): HarnessSnapshot {
    if (!ctx) {
      return {
        cwd: process.cwd(),
        model: "unknown",
        idle: true,
        activeTools: [],
        recentEvents: this.events.slice(-20),
        branch: "No Pi context attached yet.",
      };
    }

    const usage = ctx.getContextUsage?.();
    const entries = ctx.sessionManager.getBranch?.() ?? [];
    return {
      cwd: ctx.cwd,
      model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown",
      idle: ctx.isIdle(),
      contextUsage: usage ? `${usage.tokens ?? "?"}/${usage.contextWindow} tokens (${usage.percent ?? "?"}%)` : undefined,
      activeTools: ctx.sessionManager ? [] : [],
      currentEditorText: ctx.ui.getEditorText?.(),
      recentEvents: this.events.slice(-30),
      branch: summarizeBranch(entries),
    };
  }
}

export interface VoiceAgentOptions {
  watcher: HarnessWatcher;
  getHarnessContext(): VoiceHarnessContext | undefined;
  onStatus?(status: string): void;
}

export class VoiceAgent {
  private session?: AgentSession;
  private creating?: Promise<AgentSession>;
  private busy = false;
  private readonly maxRecentTurns = readPositiveIntEnv("TALKD_VOICE_RECENT_TURNS", 16);
  private readonly maxRecentProactiveDecisions = readPositiveIntEnv("TALKD_VOICE_RECENT_DECISIONS", 20);
  private readonly state = new TalkdVoiceState(this.maxRecentTurns, this.maxRecentProactiveDecisions);

  constructor(private readonly options: VoiceAgentOptions) {}

  async ask(userSpeech: string, ctx: ExtensionContext): Promise<string> {
    this.options.watcher.attach(ctx);
    const snapshot = this.enrichSnapshot(this.options.watcher.snapshot(ctx));
    const unclear = await this.tryUnclearSpeechReply(userSpeech);
    if (unclear) return unclear;
    const local = await this.tryLocalFastReply(userSpeech, snapshot);
    if (local) return local;
    const quick = await this.tryBusyHarnessReply(userSpeech, snapshot);
    if (quick) return quick;
    return this.runPrompt(buildVoicePrompt(userSpeech, snapshot), ctx, { rememberUserSpeech: userSpeech });
  }

  async askStreaming(userSpeech: string, ctx: ExtensionContext, onTextDelta: (delta: string) => void): Promise<string> {
    this.options.watcher.attach(ctx);
    const snapshot = this.enrichSnapshot(this.options.watcher.snapshot(ctx));
    const unclear = await this.tryUnclearSpeechReply(userSpeech);
    if (unclear) {
      onTextDelta(unclear);
      return unclear;
    }
    const local = await this.tryLocalFastReply(userSpeech, snapshot);
    if (local) {
      onTextDelta(local);
      return local;
    }
    const quick = await this.tryBusyHarnessReply(userSpeech, snapshot);
    if (quick) {
      onTextDelta(quick);
      return quick;
    }
    return this.runPrompt(buildVoicePrompt(userSpeech, snapshot), ctx, { onTextDelta, rememberUserSpeech: userSpeech });
  }

  async observeHarnessChange(change: string, ctx: ExtensionContext): Promise<string> {
    this.options.watcher.attach(ctx);
    const snapshot = this.enrichSnapshot(this.options.watcher.snapshot(ctx));
    const reply = await this.runPrompt(buildHarnessChangePrompt(change, snapshot), ctx);
    await this.recordProactiveDecision(change, reply);
    return reply;
  }

  isBusy(): boolean {
    return this.busy || !!this.creating;
  }

  async abort(): Promise<void> {
    await this.session?.abort();
  }

  dispose() {
    this.session?.dispose();
    this.session = undefined;
  }

  private async tryUnclearSpeechReply(userSpeech: string): Promise<string | undefined> {
    if (process.env.TALKD_UNCLEAR_FAST_REPLY === "0") return undefined;
    const reason = classifyUnclearTranscript(userSpeech);
    if (!reason) return undefined;

    const reply = "I didn't catch that. Could you repeat it?";
    voiceLatencyLog("unclear_fast_reply", { reason, transcriptChars: userSpeech.length, transcriptWords: countWords(userSpeech), replyChars: reply.length });
    await this.state.appendTurn({ user: userSpeech, assistant: reply });
    return reply;
  }

  private async tryLocalFastReply(userSpeech: string, snapshot: HarnessSnapshot): Promise<string | undefined> {
    if (process.env.TALKD_LOCAL_FAST_REPLY === "0") return undefined;
    const intent = classifyLocalFastIntent(userSpeech);
    if (!intent) return undefined;

    const reply = buildLocalFastReply(intent, snapshot);
    voiceLatencyLog("local_fast_reply", {
      mode: intent,
      transcriptChars: userSpeech.length,
      transcriptWords: countWords(userSpeech),
      harnessIdle: snapshot.idle,
      recentEvents: snapshot.recentEvents.length,
      replyChars: reply.length,
    });
    await this.state.appendTurn({ user: userSpeech, assistant: reply });
    return reply;
  }

  private async tryBusyHarnessReply(userSpeech: string, snapshot: HarnessSnapshot): Promise<string | undefined> {
    if (snapshot.idle || process.env.TALKD_BUSY_HARNESS_FAST_REPLY === "0") return undefined;

    const explicitQueueRequest = /\b(?:tell|ask|have|send|queue)\s+(?:it|pi|the\s+harness|the\s+agent)\s+(?:to|that)\b/i.test(userSpeech);
    if (explicitQueueRequest) {
      const hc = this.options.getHarnessContext();
      hc?.pi.sendUserMessage(userSpeech, { deliverAs: "followUp" });
      this.options.watcher.record(`Talkd queued follow-up for busy harness: ${userSpeech}`);
      const reply = "The main harness is still working, so I queued that as a follow-up.";
      voiceLatencyLog("busy_harness_fast_reply", { mode: "queued_followup", transcriptChars: userSpeech.length, transcriptWords: countWords(userSpeech) });
      await this.state.appendTurn({ user: userSpeech, assistant: reply });
      return reply;
    }

    const statusIntent = classifyBusyHarnessStatusIntent(userSpeech);
    if (!statusIntent) {
      voiceLatencyLog("busy_harness_fast_reply.skipped", { reason: "not_status_question", transcriptChars: userSpeech.length, transcriptWords: countWords(userSpeech) });
      return undefined;
    }

    const lastEvent = snapshot.recentEvents.at(-1);
    const reply = lastEvent
      ? `Still working. Latest: ${lastEvent}.`
      : "Still working, but you can keep talking to me.";
    voiceLatencyLog("busy_harness_fast_reply", { mode: statusIntent, transcriptChars: userSpeech.length, transcriptWords: countWords(userSpeech), recentEvents: snapshot.recentEvents.length });
    await this.state.appendTurn({ user: userSpeech, assistant: reply });
    return reply;
  }

  private async runPrompt(prompt: string, ctx: ExtensionContext, options: { onTextDelta?: (delta: string) => void; rememberUserSpeech?: string } = {}): Promise<string> {
    const sessionStart = nowMs();
    const session = await this.getSession(ctx);
    voiceLatencyLog("prompt.session_ready", { ms: elapsedMs(sessionStart), promptChars: prompt.length, promptWords: countWords(prompt) });
    this.busy = true;
    this.options.onStatus?.("voice-agent: thinking");
    let streamed = "";
    const promptStart = nowMs();
    let sawFirstDelta = false;
    const unsubscribe = options.onTextDelta
      ? session.subscribe((event) => {
        if (event.type !== "message_update") return;
        const assistantEvent = (event as { assistantMessageEvent?: { type?: string; delta?: unknown } }).assistantMessageEvent;
        if (assistantEvent?.type !== "text_delta" || typeof assistantEvent.delta !== "string") return;
        if (!sawFirstDelta) {
          sawFirstDelta = true;
          voiceLatencyLog("prompt.first_text_delta", { ms: elapsedMs(promptStart), deltaChars: assistantEvent.delta.length });
        }
        streamed += assistantEvent.delta;
        options.onTextDelta?.(assistantEvent.delta);
      })
      : undefined;
    try {
      voiceLatencyLog("prompt.start", { promptChars: prompt.length, promptWords: countWords(prompt), streaming: !!options.onTextDelta });
      await session.prompt(prompt, { source: "extension" });
      const reply = getLastAssistantText(session.messages) || streamed.trim() || "SILENCE";
      voiceLatencyLog("prompt.end", { ms: elapsedMs(promptStart), replyChars: reply.length, replyWords: countWords(reply), streamedChars: streamed.length, sawFirstDelta });
      if (options.rememberUserSpeech) await this.state.appendTurn({ user: options.rememberUserSpeech, assistant: reply });
      return reply;
    } finally {
      unsubscribe?.();
      this.busy = false;
    }
  }

  private async getSession(ctx: ExtensionContext): Promise<AgentSession> {
    if (this.session) return this.session;
    if (this.creating) return this.creating;

    const createStart = nowMs();
    this.creating = this.createSession(ctx).then((session) => {
      voiceLatencyLog("session.get_or_create", { ms: elapsedMs(createStart), lightweight: true });
      return session;
    }).finally(() => {
      this.creating = undefined;
    });
    this.session = await this.creating;
    return this.session;
  }

  private async createSession(ctx: ExtensionContext): Promise<AgentSession> {
    const totalStart = nowMs();
    this.options.onStatus?.("voice-agent: starting");
    const previous = process.env.TALKD_PI_VOICE_SIDE_AGENT;
    process.env.TALKD_PI_VOICE_SIDE_AGENT = "1";
    try {
      const resourceStart = nowMs();
      const resourceLoader = new DefaultResourceLoader({
        cwd: ctx.cwd,
        agentDir: getAgentDir(),
        noExtensions: true,
        noSkills: true,
        additionalSkillPaths: [talkdSideAgentSkillPath()],
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        systemPromptOverride: () => VOICE_AGENT_SYSTEM_PROMPT,
      });
      await resourceLoader.reload();
      voiceLatencyLog("session.resource_loader_reload", { ms: elapsedMs(resourceStart) });

      const sessionManager = await this.createVoiceSessionManager(ctx);
      await this.appendTalkdContext(sessionManager);
      if (!sessionManager.getSessionName()) sessionManager.appendSessionInfo("Talkd voice copilot");

      const sdkStart = nowMs();
      const { session } = await createAgentSession({
        cwd: ctx.cwd,
        model: ctx.model,
        resourceLoader,
        sessionManager,
        tools: VOICE_TOOL_NAMES,
        customTools: this.createTools(),
      });
      voiceLatencyLog("session.create_agent_session", { ms: elapsedMs(sdkStart), totalMs: elapsedMs(totalStart), messages: session.messages.length });
      return session;
    } finally {
      if (previous === undefined) delete process.env.TALKD_PI_VOICE_SIDE_AGENT;
      else process.env.TALKD_PI_VOICE_SIDE_AGENT = previous;
    }
  }

  private async createVoiceSessionManager(ctx: ExtensionContext): Promise<SessionManager> {
    const start = nowMs();
    const sessionManager = process.env.TALKD_VOICE_SESSION_DIR
      ? SessionManager.continueRecent(ctx.cwd, process.env.TALKD_VOICE_SESSION_DIR)
      : SessionManager.inMemory(ctx.cwd);
    voiceLatencyLog("session.lightweight", {
      ms: elapsedMs(start),
      persisted: !!process.env.TALKD_VOICE_SESSION_DIR,
      entries: sessionManager.getEntries().length,
    });
    return sessionManager;
  }

  private async appendTalkdContext(sessionManager: SessionManager): Promise<void> {
    const start = nowMs();
    sessionManager.appendCustomMessageEntry(
      SIDE_AGENT_INSTRUCTIONS_TYPE,
      buildSideAgentInstructionsMessage(),
      false,
      { source: "talkd" },
    );

    const skillStart = nowMs();
    const sideAgentSkill = await loadTalkdSideAgentSkill();
    sessionManager.appendCustomMessageEntry(
      SIDE_AGENT_SKILL_TYPE,
      formatSideAgentSkillMessage(sideAgentSkill.content),
      false,
      { source: "talkd", skill: sideAgentSkill.name, version: sideAgentSkill.version, path: sideAgentSkill.path, fallback: sideAgentSkill.fallback },
    );
    voiceLatencyLog("side_agent_skill.loaded", { ms: elapsedMs(skillStart), skill: sideAgentSkill.name, version: sideAgentSkill.version, chars: sideAgentSkill.content.length, fallback: sideAgentSkill.fallback });

    const recentContextStart = nowMs();
    const recentContext = await this.state.contextMessage();
    voiceLatencyLog("state.context_load_for_session", { ms: elapsedMs(recentContextStart), chars: recentContext.length, tokenish: estimateTokenish(recentContext) });
    if (recentContext) {
      sessionManager.appendCustomMessageEntry(
        RECENT_CONTEXT_TYPE,
        recentContext,
        false,
        { source: "talkd", maxTurns: this.maxRecentTurns, maxProactiveDecisions: this.maxRecentProactiveDecisions },
      );
    }
    voiceLatencyLog("session.append_talkd_context", { ms: elapsedMs(start), entries: sessionManager.getEntries().length, recentContextChars: recentContext.length, sideAgentSkill: sideAgentSkill.name, sideAgentSkillVersion: sideAgentSkill.version });
  }

  private async recordProactiveDecision(change: string, reply: string): Promise<void> {
    const session = this.session;
    if (!session) return;
    const decision = /^\s*(silence|no response|nothing)\s*\.?\s*$/i.test(reply) ? "SILENCE" : "SPOKEN_UPDATE";
    const content = [
      "<<<TALKD_PROACTIVE_DECISION_BEGIN>>>",
      "record_type: proactive_harness_update_decision",
      `decision: ${decision}`,
      `harness_change: ${truncate(change.replace(/\s+/g, " ").trim(), 1200)}`,
      `talkd_response: ${truncate(reply.replace(/\s+/g, " ").trim(), 1200)}`,
      "<<<TALKD_PROACTIVE_DECISION_END>>>",
    ].join("\n");
    await session.sendCustomMessage(
      {
        customType: PROACTIVE_DECISION_TYPE,
        content,
        display: false,
        details: { decision, source: "harness_change" },
      },
      { triggerTurn: false },
    );
    const stateStart = nowMs();
    await this.state.appendProactiveDecision({ decision, harnessChange: change, talkdResponse: reply });
    voiceLatencyLog("state.append_proactive_decision", { ms: elapsedMs(stateStart), decision, changeChars: change.length, responseChars: reply.length });
  }

  private enrichSnapshot(snapshot: HarnessSnapshot): HarnessSnapshot {
    const hc = this.options.getHarnessContext();
    return hc ? { ...snapshot, activeTools: hc.pi.getActiveTools() } : snapshot;
  }

  private createTools(): ToolDefinition[] {
    const getHarnessContext = () => this.options.getHarnessContext();
    const watcher = this.options.watcher;

    return [
      {
        name: "get_harness_state",
        label: "Get harness state",
        description: "Read the current visible Pi harness session state, recent events, editor text, and branch summary.",
        parameters: Type.Object({}),
        async execute() {
          const hc = getHarnessContext();
          const snapshot = hc ? { ...watcher.snapshot(hc.ctx), activeTools: hc.pi.getActiveTools() } : watcher.snapshot();
          return {
            content: [{ type: "text", text: JSON.stringify(snapshot, null, 2) }],
            details: undefined,
          };
        },
      },
      {
        name: "send_to_harness",
        label: "Send to harness",
        description:
          "Send an instruction/message to the real Pi coding harness when the user wants the coding agent to do work. Use this only for actionable work, not for conversational replies.",
        parameters: Type.Object({
          message: Type.String({ description: "The exact message to send to the main Pi harness." }),
          deliverAs: Type.Optional(
            Type.Union([Type.Literal("steer"), Type.Literal("followUp")], {
              description: "Use steer to interrupt/guide current work, followUp to queue after current turn.",
            }),
          ),
        }),
        async execute(_toolCallId, params) {
          const p = params as { message: string; deliverAs?: "steer" | "followUp" };
          const hc = getHarnessContext();
          if (!hc) {
            return { isError: true, content: [{ type: "text", text: "No active Pi harness context." }], details: undefined };
          }
          hc.pi.sendUserMessage(p.message, { deliverAs: p.deliverAs ?? "steer" });
          watcher.record(`voice sent to harness: ${p.message}`);
          return { content: [{ type: "text", text: "Sent to the main Pi harness." }], details: undefined };
        },
      },
      {
        name: "add_harness_note",
        label: "Add harness note",
        description:
          "Add a hidden contextual note to the real Pi harness session without triggering a turn. Use for short state/preferences the coding agent should know later.",
        parameters: Type.Object({
          note: Type.String({ description: "A short hidden note to add to the main session context." }),
          triggerTurn: Type.Optional(Type.Boolean({ description: "Whether to trigger a main harness LLM turn." })),
        }),
        async execute(_toolCallId, params) {
          const p = params as { note: string; triggerTurn?: boolean };
          const hc = getHarnessContext();
          if (!hc) {
            return { isError: true, content: [{ type: "text", text: "No active Pi harness context." }], details: undefined };
          }
          hc.pi.sendMessage(
            {
              customType: CUSTOM_TYPE,
              content: p.note,
              display: false,
              details: { source: "voice-agent" },
            },
            { triggerTurn: p.triggerTurn ?? false, deliverAs: "nextTurn" },
          );
          watcher.record(`voice added hidden harness note: ${p.note}`);
          return { content: [{ type: "text", text: "Added hidden note to the main Pi harness." }], details: undefined };
        },
      },
    ];
  }
}

type LocalFastIntent = "presence" | "ack" | "status" | "done_check";
type BusyHarnessStatusIntent = "presence" | "status" | "done_check";
type UnclearTranscriptReason = "empty" | "stt_marker" | "garbled_fragment";

function classifyUnclearTranscript(userSpeech: string): UnclearTranscriptReason | undefined {
  const raw = userSpeech.trim();
  if (!raw) return "empty";

  const text = normalizeUtterance(raw);
  if (!text) return "empty";
  if (/^(silence|inaudible|unintelligible|unclear|noise|music|laughter|no speech|blank)$/.test(text)) return "stt_marker";
  if (/\b(?:inaudible|unintelligible|unclear speech|silence)\b/.test(text) && countWords(text) <= 4) return "stt_marker";

  // Conservative catches for common Whisper/Kokoro low-signal fragments that
  // sound grammatical but do not carry an actionable or conversational intent.
  if (/^(?:first of all\s+)?(?:the\s+)?videos?\s+for\s+(?:years|years now|now)$/.test(text)) return "garbled_fragment";
  if (/^(?:first of all|now|so|okay)\s+(?:the\s+)?(?:videos?|ideas?)\s+for\s+(?:years|years now|now|later now)$/.test(text)) return "garbled_fragment";

  return undefined;
}

function classifyBusyHarnessStatusIntent(userSpeech: string): BusyHarnessStatusIntent | undefined {
  const text = normalizeUtterance(userSpeech);
  if (!text) return undefined;

  if (/^(hi|hello|hey|hey talkd|talkd|are you there|you there|can you hear me|do you hear me|testing|test)$/.test(text)) return "presence";
  if (/^(is it done|are we done|done yet|is the harness done|did it finish|has it finished|is pi done|is the task done)$/.test(text)) return "done_check";
  if (/^(status|update|quick update|give me an update|what's up|whats up|what is up|what's happening|whats happening|what is happening|what's going on|whats going on|what is going on|where are we|what are you doing|what's pi doing|whats pi doing|what is pi doing|what's the harness doing|whats the harness doing|what is the harness doing|tell me the status|give me the status)$/.test(text)) return "status";

  return undefined;
}

function classifyLocalFastIntent(userSpeech: string): LocalFastIntent | undefined {
  const text = normalizeUtterance(userSpeech);
  if (!text) return undefined;

  if (/^(hi|hello|hey|hey talkd|talkd|are you there|you there|can you hear me|do you hear me|testing|test)$/.test(text)) {
    return "presence";
  }
  if (/^(thanks|thank you|thanks talkd|thank you talkd|ok|okay|okay thanks|ok thanks|cool|got it|sounds good|never mind|nevermind|that's all|that is all)$/.test(text)) {
    return "ack";
  }
  if (/^(is it done|are we done|done yet|is the harness done|did it finish|has it finished|is pi done|is the task done)$/.test(text)) {
    return "done_check";
  }
  if (/^(status|update|quick update|give me an update|what's up|whats up|what is up|what's happening|whats happening|what is happening|what's going on|whats going on|what is going on|where are we|what are you doing|what's pi doing|whats pi doing|what is pi doing|what's the harness doing|whats the harness doing|what is the harness doing|tell me the status|give me the status)$/.test(text)) {
    return "status";
  }

  return undefined;
}

function buildLocalFastReply(intent: LocalFastIntent, snapshot: HarnessSnapshot): string {
  if (intent === "ack") return "Got it.";

  const latest = latestHarnessEvent(snapshot);
  if (intent === "presence") {
    return snapshot.idle ? "I’m here. The harness looks idle." : "I’m here. The harness is still working.";
  }

  if (intent === "done_check") {
    if (snapshot.idle) return latest ? `It looks done or idle. Latest: ${latest}` : "It looks done or idle now.";
    return latest ? `Not yet. The harness is still working. Latest: ${latest}` : "Not yet. The harness is still working.";
  }

  if (snapshot.idle) return latest ? `The harness is idle. Latest: ${latest}` : "The harness is idle right now.";
  return latest ? `The harness is still working. Latest: ${latest}` : "The harness is still working right now.";
}

function latestHarnessEvent(snapshot: HarnessSnapshot): string | undefined {
  const latest = snapshot.recentEvents.at(-1)?.replace(/\s+/g, " ").trim();
  if (!latest) return undefined;
  return truncate(latest, 95).replace(/[.!?]*$/, ".");
}

function normalizeUtterance(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/[^a-z0-9'\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const VOICE_AGENT_SYSTEM_PROMPT = `You are Talkd, a read-only coordination voice copilot for the active Pi coding harness.

You do not have coding tools and must not directly read, write, edit, run shell commands, or inspect files. You may only use your coordination tools to inspect the harness snapshot, send user-approved instructions to the main harness, or add hidden coordination notes.
Follow the activated Talkd side-agent skill in your hidden context for how to speak, what harness signals to watch, and when to stay silent.`;

function buildVoicePrompt(userSpeech: string, snapshot: HarnessSnapshot): string {
  return `You are the user's voice copilot for the active Pi coding harness.

You run as a lightweight separate Talkd side-agent for the active visible Pi harness. The visible/main coding harness is a different session.
Your job is to have a natural spoken conversation with the user about what is happening in the harness, and to coordinate with the main harness only when useful.

Important behavior:
- Use the current harness snapshot and get_harness_state tool for main harness context; do not assume the full main Pi transcript is prepended to your context.
- Recent persisted Talkd conversation and decisions are available for continuity and recency.
- You are read-only/coordination-only: do not directly read files, edit files, write files, or run shell commands.
- Do NOT merely repeat/read the main assistant's messages.
- Talk to the user conversationally and briefly.
- Use get_harness_state when you need fresher details about the visible harness.
- If the user asks you to make the coding harness do something, call send_to_harness with a clear actionable instruction for the main harness.
- If the user gives durable context/preferences, call add_harness_note.
- If you send work to the harness, tell the user briefly what you sent.
- Keep spoken replies short: one natural sentence by default, ideally under 120 characters unless the user explicitly asks for detail.
- If the transcript seems garbled, low-signal, or you are not confident what the user meant, say exactly: I didn't catch that. Could you repeat it?
- Do not offer multiple guessed alternatives for unclear speech.
- Do not include markdown, bullets, or code unless the user explicitly asks.

Current harness snapshot:
${JSON.stringify(snapshot, null, 2)}

User just said:
${userSpeech}`;
}

function buildHarnessChangePrompt(change: string, snapshot: HarnessSnapshot): string {
  return `You are the user's voice copilot for the active Pi coding harness.

The visible/main coding harness just changed. Decide whether the user needs a short spoken update or whether you should stay quiet.

Rules:
- Use the current harness snapshot and get_harness_state tool for main harness context; do not assume the full main Pi transcript is prepended to your context.
- Recent persisted Talkd conversation and decisions are available for continuity and recency.
- You are read-only/coordination-only: do not directly read files, edit files, write files, or run shell commands.
- Do NOT read the main assistant response aloud.
- Stay silent for routine progress, normal tool output, or anything not useful to interrupt the user with.
- Speak only when it is genuinely helpful: a task finished, something failed, the harness needs user attention, there is a surprising important change, or the user recently asked you to watch for this.
- If you should not speak, respond exactly: SILENCE
- If you speak, use one short natural sentence, ideally under 90 characters.
- You may call get_harness_state if needed.
- You may call send_to_harness only if an automatic corrective/coordination message is clearly needed.

Change:
${change}

Current harness snapshot:
${JSON.stringify(snapshot, null, 2)}`;
}

interface TalkdTurn {
  ts: string;
  user: string;
  assistant: string;
}

interface ProactiveDecisionRecord {
  ts: string;
  decision: "SILENCE" | "SPOKEN_UPDATE";
  harnessChange: string;
  talkdResponse: string;
}

interface TalkdVoiceStateFile {
  version: 1;
  updatedAt: string;
  turns: TalkdTurn[];
  proactiveDecisions: ProactiveDecisionRecord[];
}

class TalkdVoiceState {
  private readonly path = process.env.TALKD_VOICE_STATE_PATH ?? join(getAgentDir(), "talkd-voice-state.json");
  private data?: TalkdVoiceStateFile;

  constructor(private readonly maxTurns: number, private readonly maxProactiveDecisions: number) {}

  async contextMessage(): Promise<string> {
    const start = nowMs();
    const data = await this.read();
    const turns = data.turns.slice(-this.maxTurns);
    const decisions = data.proactiveDecisions.slice(-this.maxProactiveDecisions);
    if (turns.length === 0 && decisions.length === 0) {
      voiceLatencyLog("state.context_message", { ms: elapsedMs(start), turns: 0, proactiveDecisions: 0, chars: 0 });
      return "";
    }

    const message = [
      "<<<TALKD_RECENT_STATE_BEGIN>>>",
      "record_type: persisted_talkd_recent_voice_state",
      `state_file: ${this.path}`,
      "",
      `Recent Talkd user/assistant turns (${turns.length}):`,
      ...turns.flatMap((turn, index) => [
        `turn_${index + 1}_ts: ${turn.ts}`,
        `user: ${oneLine(turn.user)}`,
        `talkd: ${oneLine(turn.assistant)}`,
      ]),
      "",
      `Recent Talkd proactive decisions (${decisions.length}):`,
      ...decisions.flatMap((record, index) => [
        `decision_${index + 1}_ts: ${record.ts}`,
        `decision: ${record.decision}`,
        `harness_change: ${oneLine(record.harnessChange)}`,
        `talkd_response: ${oneLine(record.talkdResponse)}`,
      ]),
      "<<<TALKD_RECENT_STATE_END>>>",
    ].join("\n");
    voiceLatencyLog("state.context_message", { ms: elapsedMs(start), turns: turns.length, proactiveDecisions: decisions.length, chars: message.length, tokenish: estimateTokenish(message) });
    return message;
  }

  async appendTurn(turn: { user: string; assistant: string }): Promise<void> {
    const start = nowMs();
    const data = await this.read();
    data.turns.push({
      ts: new Date().toISOString(),
      user: truncate(turn.user.trim(), 2000),
      assistant: truncate(turn.assistant.trim(), 2000),
    });
    data.turns = data.turns.slice(-this.maxTurns);
    data.updatedAt = new Date().toISOString();
    await this.write(data);
    voiceLatencyLog("state.append_turn", { ms: elapsedMs(start), userChars: turn.user.length, assistantChars: turn.assistant.length, turns: data.turns.length });
  }

  async appendProactiveDecision(record: { decision: "SILENCE" | "SPOKEN_UPDATE"; harnessChange: string; talkdResponse: string }): Promise<void> {
    const start = nowMs();
    const data = await this.read();
    data.proactiveDecisions.push({
      ts: new Date().toISOString(),
      decision: record.decision,
      harnessChange: truncate(record.harnessChange.trim(), 2000),
      talkdResponse: truncate(record.talkdResponse.trim(), 2000),
    });
    data.proactiveDecisions = data.proactiveDecisions.slice(-this.maxProactiveDecisions);
    data.updatedAt = new Date().toISOString();
    await this.write(data);
    voiceLatencyLog("state.append_proactive_decision_file", { ms: elapsedMs(start), decision: record.decision, changeChars: record.harnessChange.length, responseChars: record.talkdResponse.length, proactiveDecisions: data.proactiveDecisions.length });
  }

  private async read(): Promise<TalkdVoiceStateFile> {
    if (this.data) return this.data;
    const start = nowMs();
    try {
      const raw = await readFile(this.path, "utf8");
      const parsed = JSON.parse(raw) as Partial<TalkdVoiceStateFile>;
      if (parsed.version === 1 && Array.isArray(parsed.turns)) {
        this.data = {
          version: 1,
          updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
          turns: parsed.turns.filter(isTalkdTurn).slice(-this.maxTurns),
          proactiveDecisions: Array.isArray(parsed.proactiveDecisions)
            ? parsed.proactiveDecisions.filter(isProactiveDecisionRecord).slice(-this.maxProactiveDecisions)
            : [],
        };
        voiceLatencyLog("state.read", { ms: elapsedMs(start), path: this.path, turns: this.data.turns.length, proactiveDecisions: this.data.proactiveDecisions.length, bytes: Buffer.byteLength(raw) });
        return this.data;
      }
    } catch {
      // Missing or unreadable Talkd state should not block the side-agent.
    }
    this.data = { version: 1, updatedAt: new Date().toISOString(), turns: [], proactiveDecisions: [] };
    voiceLatencyLog("state.read", { ms: elapsedMs(start), path: this.path, turns: 0, proactiveDecisions: 0, missingOrUnreadable: true });
    return this.data;
  }

  private async write(data: TalkdVoiceStateFile): Promise<void> {
    const start = nowMs();
    this.data = data;
    await mkdir(dirname(this.path), { recursive: true });
    const serialized = `${JSON.stringify(data, null, 2)}\n`;
    await writeFile(this.path, serialized, "utf8");
    voiceLatencyLog("state.write", { ms: elapsedMs(start), path: this.path, bytes: Buffer.byteLength(serialized), turns: data.turns.length, proactiveDecisions: data.proactiveDecisions.length });
  }
}

function buildSideAgentInstructionsMessage(): string {
  return [
    "<<<TALKD_SIDE_AGENT_INSTRUCTIONS_BEGIN>>>",
    "record_type: talkd_side_agent_instructions",
    "Talkd runs as a lightweight side-agent context for spoken coordination with the active Pi coding harness.",
    "Main harness context is available through each prompt's current harness snapshot and the get_harness_state tool, not by prepending the full main Pi transcript.",
    "An explicit Talkd side-agent skill is activated in this hidden context. Follow that skill as the runtime source of truth for speaking, watching, proactive updates, and read-only coordination behavior.",
    "Persisted recent Talkd conversation and decisions are appended after the skill for continuity and recency.",
    "<<<TALKD_SIDE_AGENT_INSTRUCTIONS_END>>>",
  ].join("\n");
}

function formatSideAgentSkillMessage(content: string): string {
  return [
    "<<<TALKD_SIDE_AGENT_SKILL_BEGIN>>>",
    content,
    "<<<TALKD_SIDE_AGENT_SKILL_END>>>",
  ].join("\n");
}

function isTalkdTurn(value: unknown): value is TalkdTurn {
  const turn = value as Partial<TalkdTurn> | undefined;
  return typeof turn?.ts === "string" && typeof turn.user === "string" && typeof turn.assistant === "string";
}

function isProactiveDecisionRecord(value: unknown): value is ProactiveDecisionRecord {
  const record = value as Partial<ProactiveDecisionRecord> | undefined;
  return typeof record?.ts === "string" && (record.decision === "SILENCE" || record.decision === "SPOKEN_UPDATE") && typeof record.harnessChange === "string" && typeof record.talkdResponse === "string";
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function summarizeBranch(entries: readonly SessionEntry[]): string {
  if (entries.length === 0) return "No conversation yet.";
  const recent = entries.slice(-12).map((entry) => summarizeEntry(entry)).filter(Boolean);
  return recent.join("\n");
}

function summarizeEntry(entry: SessionEntry): string {
  if (entry.type === "message") {
    const role = entry.message.role;
    const text = getMessageText(entry.message).replace(/\s+/g, " ").trim();
    return `${role}: ${truncate(text, 700)}`;
  }
  if (entry.type === "custom_message") {
    const content = typeof entry.content === "string" ? entry.content : entry.content.map((p) => "text" in p ? p.text : "[image]").join(" ");
    return `context(${entry.customType}): ${truncate(content, 500)}`;
  }
  if (entry.type === "compaction") return `compaction: ${truncate(entry.summary, 500)}`;
  if (entry.type === "branch_summary") return `branch summary: ${truncate(entry.summary, 500)}`;
  if (entry.type === "model_change") return `model changed: ${entry.provider}/${entry.modelId}`;
  if (entry.type === "thinking_level_change") return `thinking level: ${entry.thinkingLevel}`;
  return "";
}

export function getMessageText(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const p = part as { type?: string; text?: string; name?: string; arguments?: unknown };
      if (p.type === "text" && typeof p.text === "string") return p.text;
      if (p.type === "toolCall") return `[tool call: ${p.name ?? "unknown"}]`;
      return "";
    })
    .filter(Boolean)
    .join(" ");
}

function getLastAssistantText(messages: readonly AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role === "assistant") return getMessageText(msg).trim();
  }
  return "";
}

function countWords(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

function estimateTokenish(value: string | number): number {
  const chars = typeof value === "number" ? value : value.length;
  return Math.ceil(chars / 4);
}

function nowMs(): number {
  return Date.now();
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Math.round(nowMs() - startedAt));
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3)}...`;
}
