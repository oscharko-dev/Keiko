// Shared card grammar for per-turn role checks and the reload/accessibility audit.
// Production renders a known Jira tool's card as a native fieldset (implicit group role), an
// approval or receipt as a section that holds the heading and status directly, and a non-Jira (MCP)
// receipt as a plain div inside its section (JiraChatTools.tsx, JiraWriteApproval.tsx).
const CARD_SHAPE = ":has(> strong):has(> output)";
export const RESULT_CARDS = [
  `section[aria-label]${CARD_SHAPE}`,
  `[role="group"][aria-label]${CARD_SHAPE}`,
  `fieldset[aria-label]${CARD_SHAPE}`,
  `section[aria-label] > div${CARD_SHAPE}`,
].join(", ");

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
