// The model writer of the corpus generator (#4208): filler and surrounding text from an
// OpenAI-compatible chat endpoint named by the operator (a local gateway or any compatible server).
// No provider SDK is imported (ADR-0019 trust-1); the request is a plain HTTP POST. The model never
// sees a fact of the blueprint: it is asked for generic work talk and for paragraphs with a marker,
// and the generator inserts every fact sentence itself, so a model cannot rewrite or drop a truth.
//
// One request produces one filler block (ten exchanges) or one pool of paragraphs or sentences that
// is then sampled with the seeded random source. Every request is bounded in tokens and time and is
// retried a few times; errors name the HTTP status or the error class and never echo a response body.
import { setTimeout as delay } from "node:timers/promises";
import { CorpusError } from "./errors.mjs";
import { FACT_MARKER } from "./writer-port.mjs";

const LANGUAGE_NAMES = Object.freeze({ de: "German", en: "English" });
const WORK_TOPICS = Object.freeze([
  "planning the week",
  "preparing a document",
  "a meeting",
  "reading numbers",
  "an incoming request",
  "learning a concept",
  "writing a short text",
  "scheduling",
  "reviewing a draft",
  "estimating effort",
  "organising files",
  "a deadline",
]);
const SYSTEM_PROMPT =
  "You write synthetic chat transcripts for a software test corpus. Every person, company and product is invented: never use real names, brands, addresses, numbers or credentials. Answer with JSON only.";
const RULES =
  "The user only asks or requests; the user never states preferences, habits, decisions, a job title, an employer or anything about other people. No names of people, companies or products. No numbers that look like accounts, phone numbers, e-mail addresses or keys. No message may start with a command such as remember, forget, note or save.";
const TRANSIENT_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const POOL_SIZE = 10;
const DEFAULTS = Object.freeze({
  timeoutMs: 120000,
  maxAttempts: 3,
  retryDelayMs: 1000,
  temperature: 0.9,
  reasoningTokens: 8192,
});

function chatUrl(endpoint) {
  let end = endpoint.length;
  while (end > 0 && endpoint.charAt(end - 1) === "/") end -= 1;
  const base = endpoint.slice(0, end);
  return base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
}

function requestInit(settings, prompt, maxTokens) {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(settings.apiKey ? { authorization: `Bearer ${settings.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: settings.model,
      temperature: settings.temperature,
      max_tokens: maxTokens + settings.reasoningTokens,
      stream: false,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
    }),
    signal: globalThis.AbortSignal.timeout(settings.timeoutMs),
  };
}

class Transient extends Error {}

async function post(settings, prompt, maxTokens) {
  let response;
  try {
    response = await settings.fetchImpl(settings.url, requestInit(settings, prompt, maxTokens));
  } catch (error) {
    throw new Transient(`the request failed (${error?.name ?? "error"})`, { cause: error });
  }
  if (response.ok) return response;
  const reason = `HTTP ${String(response.status)}`;
  if (TRANSIENT_STATUS.has(response.status)) throw new Transient(reason);
  throw new CorpusError(`the generator model refused the request (${reason})`);
}

async function attemptOnce(settings, prompt, maxTokens) {
  const response = await post(settings, prompt, maxTokens);
  let body;
  try {
    body = await response.json();
  } catch (error) {
    throw new Transient("the response was not JSON", { cause: error });
  }
  return answerContent(body?.choices?.[0]);
}

function answerContent(choice) {
  const content = choice?.message?.content;
  if (
    choice?.finish_reason === "length" &&
    (typeof content !== "string" || content.trim().length === 0)
  )
    throw new Transient("finish_reason=length with no answer (output budget exhausted)");
  if (typeof content !== "string") throw new Transient("the response held no message");
  return content;
}

// Retries a transient failure with a growing pause; the recursion keeps `await` out of a loop.
async function complete(settings, prompt, maxTokens, attempt = 1) {
  try {
    return await attemptOnce(settings, prompt, maxTokens);
  } catch (error) {
    if (!(error instanceof Transient)) throw error;
    if (attempt >= settings.maxAttempts)
      throw new CorpusError(
        `the generator model failed after ${String(attempt)} attempts: ${error.message}`,
        { cause: error },
      );
    await settings.sleep(settings.retryDelayMs * attempt);
    return complete(settings, prompt, maxTokens, attempt + 1);
  }
}

/**
 * The JSON array in a model answer, with or without a code fence or a sentence around it; undefined
 * when there is none. The outermost brackets delimit it, so a fence needs no special handling.
 */
export function parseJsonArray(content) {
  const first = content.indexOf("[");
  const last = content.lastIndexOf("]");
  if (first < 0 || last < first) return undefined;
  try {
    const parsed = JSON.parse(content.slice(first, last + 1));
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function recordRefusal(refusals, reason) {
  refusals[reason] = (refusals[reason] ?? 0) + 1;
}

function refusalSummary(refusals) {
  return Object.entries(refusals)
    .map(([kind, count]) => `${kind}=${String(count)}`)
    .toSorted()
    .join(",");
}

// A request whose answer does not parse into the wanted shape is asked again, a bounded number of times.
async function requestList(settings, prompt, maxTokens, accept, refusals = {}, attempt = 1) {
  const items = parseJsonArray(await complete(settings, prompt, maxTokens));
  if (items === undefined) recordRefusal(refusals, "invalid-json-array");
  const accepted = items === undefined ? [] : accept(items);
  if (accepted.length > 0) return accepted;
  if (attempt >= settings.maxAttempts)
    throw new CorpusError(
      `the generator model returned no usable items (refusals: ${refusalSummary(refusals) || "item-shape"})`,
    );
  return requestList(settings, prompt, maxTokens, accept, refusals, attempt + 1);
}

function topicHint(random) {
  return random.shuffle(WORK_TOPICS).slice(0, 3).join(", ");
}

function exchangePrompt(request) {
  const language = LANGUAGE_NAMES[request.language];
  return [
    `Write ${String(request.count)} short, independent exchanges between a ${request.role} and an AI assistant, in ${language}.`,
    'Each exchange has a "user" message (one to three sentences: a request or a question about everyday work) and an "assistant" message (one to three sentences: a helpful reply).',
    RULES,
    `Vary the topics, for example: ${topicHint(request.random)}.`,
    request.styleNotes ? `Style of the user: ${request.styleNotes}` : "",
    `Return a JSON array of exactly ${String(request.count)} objects with the keys "user" and "assistant". No commentary.`,
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

function exchangeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function cleanExchange(item, request, refusals) {
  const user = exchangeText(item?.user);
  const assistant = exchangeText(item?.assistant);
  if (user.length === 0 || assistant.length === 0) {
    recordRefusal(refusals, "missing-message");
    return undefined;
  }
  for (const text of [user, assistant]) {
    if (request.isClean(text)) continue;
    recordRefusal(refusals, request.refusalClass?.(text) ?? "filtered-text");
    return undefined;
  }
  return { user, assistant };
}

// Collects clean exchanges until `count` are there, asking again for the shortfall.
async function collectExchanges(settings, request, collected = [], round = 1, refusals = {}) {
  const wanted = request.count - collected.length;
  const fresh = await requestList(
    settings,
    exchangePrompt({ ...request, count: wanted }),
    Math.min(4096, 200 + 140 * wanted),
    (items) =>
      items
        .map((item) => cleanExchange(item, request, refusals))
        .filter((exchange) => exchange !== undefined),
    refusals,
  );
  const all = [...collected, ...fresh];
  if (all.length >= request.count) return all.slice(0, request.count);
  if (round >= settings.maxAttempts)
    throw new CorpusError(
      `the generator model did not return enough clean exchanges (accepted=${String(all.length)}, wanted=${String(request.count)}; refusals: ${refusalSummary(refusals)})`,
    );
  return collectExchanges(settings, request, all, round + 1, refusals);
}

function paragraphPrompt(request) {
  const language = LANGUAGE_NAMES[request.language];
  const around =
    request.hardness === "embedded"
      ? "Around the marker put everyday work context: a task, a question and a request."
      : "Put small talk before and after the marker: greetings, remarks about the day, thanks.";
  return [
    `Write ${String(POOL_SIZE)} different user messages of three to five sentences for a ${request.role}, in ${language}.`,
    `Each message contains the marker ${FACT_MARKER} exactly once. The marker stands for one more sentence about the person, which will be added later; do not write that sentence and do not replace the marker. ${around}`,
    RULES,
    `Vary the topics, for example: ${topicHint(request.random)}.`,
    `Return a JSON array of ${String(POOL_SIZE)} strings. No commentary.`,
  ].join("\n");
}

function sentencePrompt(request) {
  const language = LANGUAGE_NAMES[request.language];
  const task = {
    ack: "short, neutral one-sentence replies of an AI assistant that acknowledge what the user just told it, without repeating or commenting on it",
    "lead-answer":
      "short one-sentence replies of an AI assistant that invite the user to go ahead and tell it more",
  }[request.kind];
  if (task === undefined) throw new CorpusError(`the model writer cannot write ${request.kind}`);
  return [
    `Write ${String(POOL_SIZE)} different ${task}, in ${language}.`,
    RULES,
    `Return a JSON array of ${String(POOL_SIZE)} strings. No commentary.`,
  ].join("\n");
}

// The structure a pooled paragraph must have, independent of any blueprint.
function structuredParagraph(item) {
  if (typeof item !== "string" || item.split(FACT_MARKER).length !== 2) return undefined;
  return item.replace(/\s+/gu, " ").trim();
}

function structuredSentence(item) {
  if (typeof item !== "string") return undefined;
  const text = item.replace(/\s+/gu, " ").trim();
  return text.length > 0 ? text : undefined;
}

function present(items) {
  return items.filter((item) => item !== undefined);
}

// A pool is requested once per key and sampled afterwards; a cache hit costs no request. It holds
// text that is well formed for any blueprint; the blueprint's own terms are applied when a sentence
// is drawn, so one writer can serve a whole build of different people.
function pooled(settings, key, produce) {
  if (!settings.pools.has(key)) settings.pools.set(key, produce());
  return settings.pools.get(key);
}

function drawClean(pool, request, textOf) {
  const usable = pool.filter((item) => request.isClean(textOf(item)));
  if (usable.length === 0)
    throw new CorpusError(
      "every pooled text states a fact of the blueprint (refusals: " +
        refusalSummary(
          pool.reduce((counts, item) => {
            recordRefusal(counts, request.refusalClass?.(textOf(item)) ?? "filtered-text");
            return counts;
          }, {}),
        ) +
        ")",
    );
  return request.random.pick(usable);
}

/**
 * Creates a model writer. `endpoint` is an OpenAI-compatible base URL, `model` the model id,
 * `apiKey` an optional bearer token (the caller reads it from the environment; it is never logged).
 * `fetchImpl`, `sleep`, `timeoutMs`, `maxAttempts` and `retryDelayMs` are injectable for tests.
 */
export function createModelWriter(options) {
  const settings = {
    ...DEFAULTS,
    sleep: delay,
    fetchImpl: globalThis.fetch,
    ...options,
    url: chatUrl(options.endpoint),
    pools: new Map(),
  };
  return {
    id: `model:${options.model}`,
    exchanges: (request) => collectExchanges(settings, request),
    paragraph: async (request) => {
      const key = `paragraph:${request.language}:${request.role}:${request.hardness}`;
      const pool = await pooled(settings, key, () =>
        requestList(settings, paragraphPrompt(request), 1800, (items) =>
          present(items.map((item) => structuredParagraph(item))),
        ),
      );
      return drawClean(pool, request, (text) => text.replace(FACT_MARKER, " "));
    },
    sentence: async (request) => {
      const key = `sentence:${request.language}:${request.kind}`;
      const pool = await pooled(settings, key, () =>
        requestList(settings, sentencePrompt(request), 700, (items) =>
          present(items.map((item) => structuredSentence(item))),
        ),
      );
      return drawClean(pool, request, (text) => text);
    },
  };
}
