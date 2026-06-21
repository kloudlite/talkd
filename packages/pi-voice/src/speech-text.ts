export function makeConversationalSummary(text: string, maxChars = 140): string {
  const spoken = limitPlainSpeech(toPlainSpeechText(text), maxChars);
  return spoken || "Done. I put the full response on screen.";
}

export function limitPlainSpeech(text: string, maxChars: number): string {
  const plain = toPlainSpeechText(text);
  if (!plain) return "";
  if (plain.length <= maxChars) return ensureTerminalPunctuation(plain);

  const completeSentences = plain.match(/[^.!?]+[.!?]+/g) ?? [];
  let spoken = "";
  for (const sentence of completeSentences) {
    const candidate = `${spoken} ${sentence.trim()}`.trim();
    if (candidate.length > maxChars) break;
    spoken = candidate;
  }
  if (spoken) return ensureTerminalPunctuation(spoken);

  return ensureTerminalPunctuation(takePhrasePrefix(plain, maxChars));
}

function takePhrasePrefix(text: string, maxChars: number): string {
  const slice = text.slice(0, Math.max(1, maxChars - 1)).trim();
  const phraseBreaks = [", ", "; ", ": ", " - "];
  let breakAt = -1;
  for (const marker of phraseBreaks) {
    const idx = slice.lastIndexOf(marker);
    if (idx > breakAt) breakAt = idx;
  }
  if (breakAt >= Math.floor(maxChars * 0.45)) return slice.slice(0, breakAt).trim();

  const wordBreak = slice.lastIndexOf(" ");
  if (wordBreak >= Math.floor(maxChars * 0.55)) return slice.slice(0, wordBreak).trim();
  return slice;
}

function ensureTerminalPunctuation(text: string): string {
  const trimmed = text.trim().replace(/[,.。，，;:]+$/, "");
  if (!trimmed) return "";
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

export function toPlainSpeechText(text: string): string {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, "")
    .replace(/[—–]/g, ", ")
    .replace(/```[\s\S]*?```/g, " I added code in the transcript. ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .replace(/[*_~#>|]/g, "")
    .replace(/-{3,}/g, " ")
    .replace(/[{}[\]();]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.!?;:])/g, "$1")
    .replace(/([,.!?;:])(?=\S)/g, "$1 ")
    .trim();
}
