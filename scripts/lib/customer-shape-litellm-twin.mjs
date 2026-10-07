import { Buffer } from "node:buffer";
import { createServer } from "node:http";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { apiKeyHeaderValue } from "../../packages/keiko-model-gateway/dist/index.js";
// The governed tool shim renders results for the model; its owner also owns the decoder (#3873).
import { decodeGovernedToolModelContent } from "../../packages/keiko-server/dist/coding-runtime/governedToolModelContent.js";

export const CUSTOMER_SHAPE_MODEL = "gemma-4-31b-it";
export const CUSTOMER_SHAPE_REPLY = "Synthetic Workbench reply.";
export const CUSTOMER_SHAPE_API_KEY = "synthetic-local-key";

function sendJson(response, payload, status = 200) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

function forcedToolName(body) {
  const choice = body.tool_choice;
  return typeof choice?.function?.name === "string" ? choice.function.name : undefined;
}

function answerText(body) {
  return JSON.stringify(body).includes("KEIKO_LONG_CONTEXT_SENTINEL")
    ? "KEIKO_LONG_CONTEXT_SENTINEL"
    : CUSTOMER_SHAPE_REPLY;
}

function writeFrame(response, delta, finishReason = null) {
  response.write(
    `data: ${JSON.stringify({
      id: "chatcmpl-customer-shape",
      object: "chat.completion.chunk",
      model: CUSTOMER_SHAPE_MODEL,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`,
  );
}

function answerStream(response, body, plannedTool) {
  const toolName = plannedTool?.name ?? forcedToolName(body);
  const toolArguments = plannedTool?.arguments ?? '{"status":"ok"}';
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  writeFrame(response, { role: "assistant", content: null });
  response.write(": ping\n\n");
  if (toolName !== undefined) {
    writeFrame(response, {
      tool_calls: [
        {
          index: 0,
          id: "call-twin",
          type: "function",
          function: { name: toolName, arguments: "" },
        },
      ],
    });
    writeFrame(response, {
      tool_calls: [{ index: 0, function: { arguments: toolArguments } }],
    });
    writeFrame(response, {}, "tool_calls");
  } else {
    writeFrame(response, { content: answerText(body) });
    writeFrame(response, {}, "stop");
  }
  response.end("data: [DONE]\n\n");
}

function truncatedStream(response) {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  writeFrame(response, { content: "Synthetic partial reply." });
  response.end();
}

function plannedWorkspaceDiscovery(body, behavior) {
  if (!behavior.workspaceDiscoveryPending || forcedToolName(body) !== undefined) return undefined;
  if (!Array.isArray(body.tools)) return undefined;
  const offered = body.tools.some((tool) => tool?.function?.name === "keiko_workspace_discover");
  if (!offered) return undefined;
  behavior.workspaceDiscoveryPending = false;
  return {
    name: "keiko_workspace_discover",
    arguments: '{"query":"README.md","maxResults":5}',
  };
}

function completedDiscoveryResult(content) {
  if (typeof content !== "string") return false;
  try {
    const result = decodeGovernedToolModelContent(content);
    return (
      result?.status === "completed" &&
      typeof result.read?.text === "string" &&
      result.read.text.split("\n").includes("README.md")
    );
  } catch {
    return false;
  }
}

function hasCompletedWorkspaceDiscoveryResult(body) {
  return (
    Array.isArray(body.messages) &&
    body.messages.some(
      (message) =>
        message?.role === "tool" &&
        message.tool_call_id === "call-twin" &&
        completedDiscoveryResult(message.content),
    )
  );
}

function answerBuffered(response, body) {
  const toolName = forcedToolName(body);
  sendJson(response, {
    id: "chatcmpl-customer-shape",
    object: "chat.completion",
    model: CUSTOMER_SHAPE_MODEL,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: answerText(body),
          ...(toolName === undefined
            ? {}
            : {
                tool_calls: [
                  {
                    id: "call-twin",
                    type: "function",
                    function: { name: toolName, arguments: '{"status":"ok"}' },
                  },
                ],
              }),
        },
        finish_reason: toolName === undefined ? "stop" : "tool_calls",
      },
    ],
    usage: { prompt_tokens: 3, completion_tokens: 3 },
  });
}

async function requestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function rejectsStreaming(body, behavior) {
  return (
    body.stream === true &&
    ("stream_options" in body || behavior.rejectAllStreams || behavior.reinsertStreamOptions)
  );
}

function streamRejection(behavior) {
  return behavior.reinsertStreamOptions && !behavior.rejectAllStreams
    ? { code: "unsupported_parameter", param: "stream_options" }
    : { code: "unsupported_parameter" };
}

async function handleTwinChat(request, response, requests, behavior) {
  try {
    const body = await requestBody(request);
    const observed = {
      stream: body.stream === true,
      hasStreamOptions: "stream_options" in body,
      delayed: false,
      truncated: false,
      deliveredToolCall: false,
      completedDiscoveryResult: hasCompletedWorkspaceDiscoveryResult(body),
    };
    requests.push(observed);
    if (rejectsStreaming(body, behavior)) {
      sendJson(response, { error: streamRejection(behavior) }, 400);
      return;
    }
    if (body.stream === true) {
      if (behavior.truncateNextAcceptedStream) {
        behavior.truncateNextAcceptedStream = false;
        observed.truncated = true;
        truncatedStream(response);
        return;
      }
      if (behavior.acceptedStreamDelayMs > 0 && forcedToolName(body) === undefined) {
        observed.delayed = true;
        await delay(behavior.acceptedStreamDelayMs);
      }
      const plannedTool = plannedWorkspaceDiscovery(body, behavior);
      observed.deliveredToolCall = plannedTool !== undefined;
      answerStream(response, body, plannedTool);
    } else answerBuffered(response, body);
  } catch {
    sendJson(response, { error: { type: "invalid_request_error" } }, 400);
  }
}

const TRANSPORT_CASES = new Set([
  "immediate",
  "delay35",
  "pause35",
  "retry429",
  "retry503",
  "partial",
]);

async function transportStreamMode(request) {
  const body = await requestBody(request);
  return body?.stream === true;
}

function transportCase(request) {
  const candidate = (request.url ?? "").split("/")[1];
  return TRANSPORT_CASES.has(candidate) ? candidate : undefined;
}

function transportModels(response) {
  sendJson(response, {
    data: [
      {
        id: CUSTOMER_SHAPE_MODEL,
        object: "model",
        model_name: CUSTOMER_SHAPE_MODEL,
        litellm_params: { custom_llm_provider: "hosted_vllm" },
        model_info: { max_input_tokens: 128_000, max_output_tokens: 4096 },
      },
    ],
  });
}

function transportReply(response, stream, text = "Synthetic gateway transport test completed.") {
  if (!stream) {
    sendJson(response, {
      model: CUSTOMER_SHAPE_MODEL,
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 8 },
    });
    return;
  }
  if (!response.headersSent) response.writeHead(200, { "content-type": "text/event-stream" });
  writeFrame(response, { content: text });
  writeFrame(response, {}, "stop");
  response.end("data: [DONE]\n\n");
}

function waitForTransportDeadline(deadline, signal) {
  return new Promise((resolve, reject) => {
    const rearm = () => {
      const remaining = deadline - performance.now();
      if (Number.isNaN(remaining) || remaining <= 0) {
        resolve();
        return;
      }
      // Early timer wakeups rearm one wait against the same monotonic deadline. The callback
      // returns no successor promise, so completed timers do not form a retained chain.
      void delay(Math.ceil(remaining), undefined, { signal }).then(rearm, reject);
    };
    rearm();
  });
}

export async function transportWait(response, milliseconds) {
  if (response.destroyed) return false;
  const controller = new globalThis.AbortController();
  const cancel = () => controller.abort();
  response.once("close", cancel);
  try {
    await waitForTransportDeadline(performance.now() + milliseconds, controller.signal);
    return !response.destroyed;
  } catch (error) {
    if (error?.name === "AbortError") return false;
    throw error;
  } finally {
    response.off("close", cancel);
  }
}

function transportCooldown(response, scenario, options) {
  const status = scenario === "retry429" ? 429 : 503;
  response.writeHead(status, {
    "content-type": "application/json",
    "retry-after": String(options.retryAfterSeconds),
  });
  response.end('{"error":{"type":"synthetic_overload"}}');
  return status;
}

function isDelayedTransport(scenario) {
  return scenario === "delay35" || scenario === "pause35";
}

async function transportChat(request, response, requests, options, scenario) {
  const stream = await transportStreamMode(request);
  const startedAt = performance.now();
  const observed = {
    scenario,
    stream,
    startedAtMs: Date.now(),
    status: 0,
    elapsedMs: 0,
    closed: false,
    completed: false,
  };
  requests.push(observed);
  response.once("close", () => {
    observed.closed = true;
    observed.elapsedMs = Math.ceil(performance.now() - startedAt);
  });
  if (scenario.startsWith("retry")) {
    const readyAt = options.readyAt.get(scenario) ?? Date.now() + options.retryAfterSeconds * 1000;
    options.readyAt.set(scenario, readyAt);
    if (Date.now() < readyAt) {
      observed.status = transportCooldown(response, scenario, options);
      return;
    }
  }
  if (scenario === "partial" && stream) {
    observed.status = 200;
    truncatedStream(response);
    return;
  }
  if (scenario === "pause35" && stream) {
    observed.status = 200;
    response.writeHead(200, { "content-type": "text/event-stream" });
    writeFrame(response, { content: "Synthetic gateway stream started. " });
  }
  if (isDelayedTransport(scenario) && !(await transportWait(response, options.delayMs))) return;
  observed.status = 200;
  transportReply(response, stream);
  observed.completed = true;
}

function handleTransportControl(request, response, requests, options) {
  if (request.method === "GET" && request.url === "/metrics") {
    sendJson(response, { requestCount: requests.length, requests });
    return true;
  }
  if (request.method === "POST" && request.url === "/reset") {
    request.resume();
    requests.length = 0;
    options.readyAt.clear();
    sendJson(response, { reset: true });
    return true;
  }
  return false;
}

export function failTransportResponse(response) {
  if (response.destroyed) return;
  if (response.headersSent) response.destroy();
  else sendJson(response, { error: { type: "invalid_request_error" } }, 400);
}

function handleTransportRequest(request, response, requests, options) {
  if (handleTransportControl(request, response, requests, options)) return;
  const scenario = transportCase(request);
  if (scenario === undefined) {
    request.resume();
    sendJson(response, { error: { type: "not_found" } }, 404);
    return;
  }
  if (request.method === "GET" && /\/(models|model\/info)$/.test(request.url ?? "")) {
    transportModels(response);
    return;
  }
  if (request.method === "POST" && (request.url ?? "").endsWith("/chat/completions")) {
    if (!acceptChatAuthentication(request, response)) return;
    void transportChat(request, response, requests, options, scenario).catch(() => {
      failTransportResponse(response);
    });
    return;
  }
  request.resume();
  sendJson(response, { error: { type: "not_found" } }, 404);
}

function acceptChatAuthentication(request, response) {
  if (
    request.headers["x-litellm-key"] === apiKeyHeaderValue("x-litellm-key", CUSTOMER_SHAPE_API_KEY)
  )
    return true;
  request.resume();
  sendJson(response, { error: { type: "authentication_error" } }, 401);
  return false;
}

function handleTwinRequest(request, response, requests, behavior) {
  if (behavior.transport !== undefined) {
    handleTransportRequest(request, response, requests, behavior.transport);
    return;
  }
  const url = request.url ?? "";
  if (request.method === "GET" && url.endsWith("/model/info")) {
    sendJson(response, {
      data: [
        {
          model_name: CUSTOMER_SHAPE_MODEL,
          litellm_params: { custom_llm_provider: "hosted_vllm" },
          model_info: {},
        },
      ],
    });
    return;
  }
  if (request.method === "GET" && url.endsWith("/models")) {
    sendJson(response, { data: [{ id: CUSTOMER_SHAPE_MODEL, object: "model" }] });
    return;
  }
  if (request.method === "POST" && url.endsWith("/chat/completions")) {
    if (!acceptChatAuthentication(request, response)) return;
    void handleTwinChat(request, response, requests, behavior);
    return;
  }
  sendJson(response, { error: { type: "not_found" } }, 404);
}

function twinBehavior(options) {
  return {
    rejectAllStreams: false,
    reinsertStreamOptions: false,
    acceptedStreamDelayMs: 0,
    workspaceDiscoveryPending: false,
    truncateNextAcceptedStream: false,
    ...(options.transportOnly
      ? {
          transport: {
            delayMs: options.delayMs ?? 35_000,
            retryAfterSeconds: options.retryAfterSeconds ?? 120,
            readyAt: new Map(),
          },
        }
      : {}),
  };
}

export async function startCustomerShapeLiteLlmTwin(options = {}) {
  const requests = [];
  const behavior = twinBehavior(options);
  const server = createServer((request, response) =>
    handleTwinRequest(request, response, requests, behavior),
  );
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("twin did not bind");
  return twinControls(server, requests, behavior, address.port);
}

function twinControls(server, requests, behavior, port) {
  return {
    baseUrl: `http://127.0.0.1:${String(port)}${behavior.transport ? "/immediate" : ""}/v1`,
    requests,
    rejectAllStreaming: () => {
      behavior.rejectAllStreams = true;
    },
    simulateProxyStreamOptionReinsertion: () => {
      behavior.reinsertStreamOptions = true;
    },
    stopProxyStreamOptionReinsertion: () => {
      behavior.reinsertStreamOptions = false;
    },
    delayAcceptedStreamingBy: (milliseconds) => {
      behavior.acceptedStreamDelayMs = milliseconds;
    },
    planSingleWorkspaceDiscovery: () => {
      behavior.workspaceDiscoveryPending = true;
    },
    truncateNextAcceptedStream: () => {
      behavior.truncateNextAcceptedStream = true;
    },
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
