import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const TALKD_SIDE_AGENT_SKILL_NAME = "talkd-side-agent-voice-copilot";
export const TALKD_SIDE_AGENT_SKILL_VERSION = "2026-06-21.5";

const FALLBACK_SKILL_CONTENT = `# Talkd Side-Agent Voice Copilot Skill\n\nYou are Talkd, a lightweight spoken copilot for the active Pi harness. Answer the user's actual question directly in one short natural sentence by default. More detail is allowed when the user explicitly asks, when a complex topic needs detail for understanding, or when summarizing meaningful behind-the-scenes progress. Use the harness snapshot, recent events, branch summary, and get_harness_state for context. Stay read-only/coordination-only. Do not repeat main assistant messages verbatim. Ask the user to repeat garbled speech. Prefer silence for routine progress, but proactively coordinate for two cases: necessary attention-needed moments and meaningful high-level behind-the-scenes progress. Summarize phase changes, evidence found, root-cause direction, validation results, and next action; do not narrate every tool or small step. Keep explanations conversational and offer to continue if the user wants more. For diagnostics that require user action, especially audio recording, stop first, announce attention is required, get readiness, show a visible action/timing banner when possible, give a spoken countdown, and never treat silence or low audio as evidence unless the user was clearly prompted and acknowledged readiness.`;

export interface TalkdSideAgentSkill {
  name: string;
  version: string;
  path: string;
  content: string;
  fallback: boolean;
}

export function talkdSideAgentSkillPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../side-agent-skills/talkd-side-agent-voice-copilot/SKILL.md");
}

let cachedSkill: Promise<TalkdSideAgentSkill> | undefined;

export function loadTalkdSideAgentSkill(): Promise<TalkdSideAgentSkill> {
  cachedSkill ??= readTalkdSideAgentSkill();
  return cachedSkill;
}

async function readTalkdSideAgentSkill(): Promise<TalkdSideAgentSkill> {
  const path = talkdSideAgentSkillPath();
  try {
    const raw = await readFile(path, "utf8");
    return {
      name: TALKD_SIDE_AGENT_SKILL_NAME,
      version: TALKD_SIDE_AGENT_SKILL_VERSION,
      path,
      content: raw.trim(),
      fallback: false,
    };
  } catch {
    return {
      name: TALKD_SIDE_AGENT_SKILL_NAME,
      version: TALKD_SIDE_AGENT_SKILL_VERSION,
      path,
      content: FALLBACK_SKILL_CONTENT,
      fallback: true,
    };
  }
}
