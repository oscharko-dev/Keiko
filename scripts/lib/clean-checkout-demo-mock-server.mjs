// A tiny loopback HTTP server that speaks just enough of the OpenAI-compatible embeddings and the
// LiteLLM-compatible reranker contracts for the clean-checkout demo (Issue #2634 / Epic #2556's
// Definition of Done). It exists so the demo drives the REAL production retrieval + rerank facade
// against a byte-deterministic responder — same input, same vector, same reranked order — on any
// host without a provider account.
//
// Not a product component. Not a mock double either — the demo really opens a TCP socket, really
// speaks HTTP, really rides the keiko-model-gateway adapter path. What is deterministic is the
// answering VALUES, so the demo is reproducible.

import { Buffer } from "node:buffer";
import { createServer } from "node:http";

const EMBEDDING_DIMENSIONS_DEFAULT = 32;

// A pure hash → unit-vector function. Chosen to give distinct-but-similar vectors for texts that
// share tokens (the multi-file grounded query relies on this: the same tokens in two indexed files
// yield overlapping vectors, so retrieval returns candidates from both).
export function deterministicEmbedding(input, dimensions) {
  const vector = new Array(dimensions).fill(0);
  const text = String(input);
  // `for...of` on a string yields one entry per **code point** — including surrogate pairs. The
  // earlier `for (i = 0; i < text.length; i += 1)` walked UTF-16 units, so a non-BMP character
  // like "😀" (two 16-bit units) was hashed twice: `codePointAt(0)` returned the full 0x1F600
  // and `codePointAt(1)` returned the low surrogate. Different embeddings for the same visible
  // text — matches CodeRabbit's L26 finding and Sonar's `sonarjs:S7758`.
  let index = 0;
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    const slot = (code + index) % dimensions;
    vector[slot] = (vector[slot] ?? 0) + ((code % 31) + 1) / 32;
    index += 1;
  }
  let sumOfSquares = 0;
  for (const value of vector) sumOfSquares += value * value;
  const norm = Math.sqrt(sumOfSquares);
  if (norm === 0) return vector.map(() => 1 / Math.sqrt(dimensions));
  return vector.map((value) => value / norm);
}

// Reverse-order rerank. Deterministic and OBVIOUSLY distinguishable from the un-reranked order, so
// the demo's evidence can prove the answer path CHANGES when the facade's external-reranking policy
// permits the transport call.
export function reverseRerankResults(documents, topN) {
  // `Math.trunc(Number(topN))` gives the same integer coercion as the historical `topN | 0`
  // without the deprecated bitwise-OR-on-a-Number idiom Sonar's `sonarjs:S7767` flags. `topN`
  // arrives from the LiteLLM request body, so Number coercion is the correct primitive.
  const bounded = Math.max(0, Math.min(Math.trunc(Number(topN)) || 0, documents.length));
  const reversedIndices = documents.map((_, index) => documents.length - 1 - index);
  return reversedIndices.slice(0, bounded).map((originalIndex, rank) => ({
    index: originalIndex,
    relevance_score: 1 - rank / Math.max(1, documents.length),
  }));
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      try {
        const value = JSON.parse(raw || "{}");
        resolve(typeof value === "object" && value !== null && !Array.isArray(value) ? value : {});
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

function respondEmbeddings(res, body, dimensions) {
  const inputs = Array.isArray(body.input) ? body.input : [String(body.input ?? "")];
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      object: "list",
      model: String(body.model ?? "keiko-clean-checkout-embedding"),
      data: inputs.map((value, index) => ({
        object: "embedding",
        index,
        embedding: deterministicEmbedding(String(value), dimensions),
      })),
      usage: { prompt_tokens: inputs.length, total_tokens: inputs.length },
    }),
  );
}

function respondRerank(res, body) {
  const documents = Array.isArray(body.documents) ? body.documents : [];
  const topN =
    typeof body.top_n === "number" && Number.isFinite(body.top_n) ? body.top_n : documents.length;
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      id: "rerank-demo",
      model: String(body.model ?? "keiko-clean-checkout-rerank"),
      results: reverseRerankResults(documents, topN),
      usage: { total_tokens: 0 },
    }),
  );
}

// Boots the server on an ephemeral loopback port and resolves once it is listening. Callers get
// { origin, close }: `origin` is the base URL to point the gateway at, `close` is idempotent and
// awaited by the demo runner in a finally block. No fs, no external network, no config file.
export function startCleanCheckoutMockServer({ embeddingDimensions } = {}) {
  const dimensions = embeddingDimensions ?? EMBEDDING_DIMENSIONS_DEFAULT;
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const path = (req.url ?? "/").split("?")[0];
      if (req.method === "GET" && path === "/healthz") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }
      if (req.method === "POST" && path?.endsWith("/embeddings")) {
        void readJsonBody(req).then((body) => respondEmbeddings(res, body, dimensions));
        return;
      }
      if (req.method === "POST" && path?.endsWith("/rerank")) {
        void readJsonBody(req).then((body) => respondRerank(res, body));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "not found" } }));
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      // TCP servers resolve to the object form; the string form is for Unix domain sockets, which
      // this server never binds. Guard the type so the port lookup below is safe.
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("clean-checkout mock server did not bind to a loopback port"));
        return;
      }
      const port = address.port;
      const origin = `http://127.0.0.1:${String(port)}`;
      resolve({ origin, close: makeIdempotentCloser(server), embeddingDimensions: dimensions });
    });
  });
}

// The listen-callback used to define its own `close` inline, which pushed a `new Promise` INSIDE
// a listener callback INSIDE `new Promise` INSIDE `startCleanCheckoutMockServer` — Sonar's
// `sonarjs:S2004` flagged five function-nesting levels. Hoisting it here also makes it directly
// unit-testable.
//
// The shutdown promise is CACHED (not just a `closed` boolean gate). CodeRabbit's L155 finding on
// the earlier revision: a second caller was resolving immediately while `server.close()` was still
// in flight, so a race could let the caller proceed before the socket was actually released.
// Caching means both callers await the exact same shutdown Promise, and only resolve after the
// underlying close completes.
function makeIdempotentCloser(server) {
  let shutdown;
  return () => {
    if (shutdown === undefined) {
      shutdown = new Promise((closeResolve) => {
        server.close(() => closeResolve(undefined));
      });
    }
    return shutdown;
  };
}
