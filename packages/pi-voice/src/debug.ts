import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const TRUE_VALUES = new Set(["1", "true", "yes", "on", "debug"]);

export type DebugFields = Record<string, string | number | boolean | undefined>;

export function isVoiceDebugEnabled(): boolean {
  return isTruthy(process.env.TALKD_VOICE_DEBUG) || isTruthy(process.env.TALKD_DEBUG);
}

export function isVoiceDebugUIEnabled(): boolean {
  return isTruthy(process.env.TALKD_VOICE_DEBUG_UI);
}

export function isVoiceLatencyDebugEnabled(): boolean {
  return isVoiceDebugEnabled() || isTruthy(process.env.TALKD_VOICE_LATENCY_DEBUG);
}

export function voiceDebugLog(label: string, fields: DebugFields = {}): void {
  if (!isVoiceDebugEnabled()) return;
  writeVoiceDebugLine(label, fields);
}

export function voiceLatencyLog(label: string, fields: DebugFields = {}): void {
  if (!isVoiceLatencyDebugEnabled()) return;
  writeVoiceDebugLine(`latency.${label}`, fields);
}

function writeVoiceDebugLine(label: string, fields: DebugFields = {}): void {
  const extra = Object.entries(fields)
    .flatMap(([key, value]) => (value === undefined ? [] : [` ${key}=${formatValue(value)}`]))
    .join("");
  const line = `${new Date().toISOString()} [talkd-voice] ${label}${extra}\n`;

  if (isTruthy(process.env.TALKD_VOICE_DEBUG_STDERR)) {
    // Explicit opt-in only: writing to stderr while Pi owns the terminal can
    // visually corrupt the active display.
    process.stderr.write(line);
    return;
  }

  const path = process.env.TALKD_VOICE_DEBUG_LOG || "/tmp/talkd-pi-voice-debug.log";
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, line);
  } catch {
    // Debug logging must never affect the voice controller or Pi UI.
  }
}

export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function isTruthy(value: string | undefined): boolean {
  return value !== undefined && TRUE_VALUES.has(value.trim().toLowerCase());
}

function formatValue(value: string | number | boolean): string {
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const singleLine = stripAnsi(value).replace(/\s+/g, " ").trim();
  return JSON.stringify(singleLine);
}
