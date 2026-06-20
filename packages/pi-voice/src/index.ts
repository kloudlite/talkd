import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { ensureTalkdServiceInBackground } from "./service-manager";
import { VoiceAgent, HarnessWatcher, getMessageText } from "./voice-agent";
import { VoiceController } from "./voice-controller";

function short(value: unknown, max = 600): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return "";
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 3)}...`;
}

export default function talkdVoiceExtension(pi: ExtensionAPI) {
  // The voice side-agent is itself a Pi SDK AgentSession. Do not recursively
  // install this voice extension inside that private in-memory session.
  if (process.env.TALKD_PI_VOICE_SIDE_AGENT === "1") return;

  let currentCtx: ExtensionContext | undefined;
  const watcher = new HarnessWatcher();
  const voiceAgent = new VoiceAgent({
    watcher,
    getHarnessContext: () => currentCtx ? { ctx: currentCtx, pi } : undefined,
  });
  let servicePromise: Promise<void> | undefined;
  const voice = new VoiceController({
    agent: voiceAgent,
    ensureService: () => {
      servicePromise ??= ensureTalkdServiceInBackground().then((service) => {
        watcher.record(service.started ? `talkd-service started (${service.logPath})` : "talkd-service reused");
      }).finally(() => {
        servicePromise = undefined;
      });
      return servicePromise;
    },
  });

  function attach(ctx: ExtensionContext) {
    currentCtx = ctx;
    watcher.attach(ctx);
  }

  function record(ctx: ExtensionContext, line: string, options?: { react?: boolean }) {
    attach(ctx);
    watcher.record(line);
    if (options?.react) voice.onHarnessEvent(line, ctx);
  }

  pi.registerCommand("voice", {
    description: "Talk to Talkd, the parallel audio assistant for this Pi harness",
    handler: async (_args, ctx) => {
      attach(ctx);
      await voice.toggle(ctx);
    },
  });

  pi.registerShortcut(Key.f12, {
    description: "Talkd assistant: talk/send/interrupt",
    handler: async (ctx) => {
      attach(ctx);
      await voice.toggle(ctx);
    },
  });

  pi.registerShortcut(Key.ctrlShift("v"), {
    description: "Talkd assistant: talk/send/interrupt",
    handler: async (ctx) => {
      attach(ctx);
      await voice.toggle(ctx);
    },
  });

  pi.on("session_start", (_event, ctx) => {
    attach(ctx);
    watcher.record(`session started in ${ctx.cwd}`);
    voice.attach(ctx);
    ctx.ui.setStatus("talkd-voice", undefined);
    ctx.ui.setWidget?.("talkd-voice", [ctx.ui.theme.fg("dim", "[START] Talkd: starting")], { placement: "belowEditor" });
    void ensureTalkdServiceInBackground()
      .then((service) => {
        watcher.record(service.started ? `talkd-service started (${service.logPath})` : "talkd-service reused");
        if (currentCtx === ctx) voice.attach(ctx);
        if (service.started) ctx.ui.notify(`talkd-service started (${service.logPath})`, "info");
      })
      .catch((error) => {
        if (currentCtx !== ctx) return;
        ctx.ui.setStatus("talkd-voice", undefined);
        ctx.ui.setWidget?.("talkd-voice", [ctx.ui.theme.fg("error", "[ERR] Talkd: error")], { placement: "belowEditor" });
        ctx.ui.notify(`Talkd unavailable: ${error instanceof Error ? error.message : String(error)}`, "warning");
      });
  });

  pi.on("input", (event, ctx) => {
    if (event.source !== "extension") record(ctx, `user input: ${short(event.text)}`);
  });

  pi.on("message_start", (event, ctx) => {
    record(ctx, `${event.message.role} message started`);
  });

  pi.on("message_end", (event, ctx) => {
    const text = short(getMessageText(event.message), 900);
    record(ctx, `${event.message.role}: ${text}`, { react: event.message.role === "assistant" });
  });

  pi.on("tool_execution_start", (event, ctx) => {
    record(ctx, `tool started: ${event.toolName} ${short(event.args, 300)}`);
  });

  pi.on("tool_execution_update", (event, ctx) => {
    record(ctx, `tool update: ${event.toolName} ${short(event.partialResult, 300)}`);
  });

  pi.on("tool_execution_end", (event, ctx) => {
    record(ctx, `tool ended: ${event.toolName} ${event.isError ? "error" : "ok"} ${short(event.result, 500)}`, {
      react: event.isError,
    });
  });

  pi.on("agent_start", (_event, ctx) => {
    record(ctx, "main harness agent started");
  });

  pi.on("agent_end", (_event, ctx) => {
    record(ctx, "main harness agent ended", { react: true });
  });

  pi.on("session_shutdown", async (event) => {
    watcher.record(`session shutdown: ${event.reason}`);
    voice.cleanup();
    currentCtx = undefined;
  });
}
