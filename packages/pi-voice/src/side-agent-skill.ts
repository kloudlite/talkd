import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const TALKD_SIDE_AGENT_SKILL_NAME = "talkd-side-agent-voice-copilot";
export const TALKD_SIDE_AGENT_SKILL_VERSION = "2026-06-21.2";

const FALLBACK_SKILL_CONTENT = `# Talkd Side-Agent Voice Copilot Skill\n\nYou are Talkd, a lightweight spoken copilot for the active Pi harness. Answer the user's actual question directly in one short natural sentence. Use the harness snapshot, recent events, branch summary, and get_harness_state for context. Stay read-only/coordination-only. Do not repeat main assistant messages verbatim. Ask the user to repeat garbled speech. Prefer silence for routine proactive updates.`;

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
      name: extractFrontmatterString(raw, "name") ?? TALKD_SIDE_AGENT_SKILL_NAME,
      version: extractFrontmatterVersion(raw) ?? TALKD_SIDE_AGENT_SKILL_VERSION,
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

function extractFrontmatterString(raw: string, key: string): string | undefined {
  const frontmatter = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatter?.[1]) return undefined;
  const match = frontmatter[1].match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  return match?.[1]?.trim().replace(/^['"]|['"]$/g, "");
}

function extractFrontmatterVersion(raw: string): string | undefined {
  const frontmatter = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatter?.[1]) return undefined;
  const match = frontmatter[1].match(/^\s*version:\s*(.+)$/m);
  return match?.[1]?.trim().replace(/^['"]|['"]$/g, "");
}
