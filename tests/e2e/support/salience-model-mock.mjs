// Shared by the e2e model mocks: how a mock recognises Keiko's salience-extraction call and answers
// it the way a model that follows the production prompt would (#4212). The prompt is imported from
// the producer, so rewording it cannot silently stop a mock from recognising the capture call.

import { SALIENCE_SYSTEM_PROMPT } from "../../../packages/keiko-memory-capture/dist/salience.js";

// The user message may open with known facts and the previous message; the person's words follow.
const SALIENCE_USER_PREFIX = "User said:\n";
const SENTENCE_BOUNDARY = /(?<=[.!?])\s+/u;

export const NO_SALIENCE_ITEMS = JSON.stringify({ items: [] });

export function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(""));
  });
}

export function isSalienceRequest(messages) {
  return messages.some(
    (message) =>
      message?.role === "system" &&
      typeof message.content === "string" &&
      message.content.startsWith(SALIENCE_SYSTEM_PROMPT),
  );
}

function currentUserText(messages) {
  const current = messages.at(-1);
  if (current?.role !== "user" || typeof current.content !== "string") return undefined;
  const start = current.content.lastIndexOf(SALIENCE_USER_PREFIX);
  return start === -1 ? undefined : current.content.slice(start + SALIENCE_USER_PREFIX.length);
}

// Extraction learns only the person's own words: the fact is the sentence of the person's current
// message that carries one of the markers, verbatim. Known facts and the previous message precede
// "User said:" and are never a source.
export function salienceReply(messages, markers) {
  const userText = currentUserText(messages);
  const marker = markers.find((candidate) => userText?.includes(candidate) === true);
  if (userText === undefined || marker === undefined) return NO_SALIENCE_ITEMS;
  const fact = userText.split(SENTENCE_BOUNDARY).find((part) => part.includes(marker));
  if (fact === undefined) return NO_SALIENCE_ITEMS;
  return JSON.stringify({
    items: [
      { body: fact, evidence: fact, about: "self", type: "fact", relation: "new", related: null },
    ],
  });
}
