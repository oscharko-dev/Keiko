// Shared card grammar for per-turn role checks and the reload/accessibility audit.
export const RESULT_CARDS =
  'section[aria-label]:has(> strong):has(> output), [role="group"][aria-label]:has(> strong):has(> output)';

const GENERIC = new Set(["Jira action", "Jira-Aktion"]);
const UNAVAILABLE = [
  /\breadable\s+view\b[^.\n]*\bunavailable\b/giu,
  /Für dieses Ergebnis ist keine lesbare Ansicht verfügbar\./gu,
];

function jsonObject(fragment) {
  try {
    const value = JSON.parse(fragment);
    return value !== null && typeof value === "object";
  } catch {
    return false;
  }
}

function consumeJsonString(state, character, inside) {
  if (state.quoted) {
    if (state.escaped) state.escaped = false;
    else if (character === "\\") state.escaped = true;
    else if (character === '"') state.quoted = false;
    return true;
  }
  if (inside && character === '"') {
    state.quoted = true;
    return true;
  }
  return false;
}

function rawJson(text) {
  const starts = [];
  const state = { quoted: false, escaped: false };
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (consumeJsonString(state, character, starts.length > 0)) continue;
    if (character === "{" || character === "[") starts.push({ index, character });
    else if (character === "}" || character === "]") {
      const start = starts.pop();
      if (start === undefined) continue;
      if ((start.character === "{") !== (character === "}")) starts.length = 0;
      else if (jsonObject(text.slice(start.index, index + 1))) return true;
    }
  }
  return false;
}

/** Counts only: no result body, key, URL or exception is retained by the presentation verdict. */
export function cardTextFindings({ title, text, preCount }) {
  return {
    generic: Number(GENERIC.has(title.trim())),
    unavailable: UNAVAILABLE.reduce(
      (total, pattern) => total + [...text.matchAll(pattern)].length,
      0,
    ),
    raw: preCount + Number(rawJson(text)),
  };
}
