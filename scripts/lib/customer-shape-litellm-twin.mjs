import { Buffer } from "node:buffer";
import { createServer } from "node:http";
import { apiKeyHeaderValue } from "../../packages/keiko-model-gateway/dist/index.js";

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

function answerStream(response, body) {
  const toolName = forcedToolName(body);
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
      tool_calls: [{ index: 0, function: { arguments: '{"status":"ok"}' } }],
    });
    writeFrame(response, {}, "tool_calls");
  } else {
    writeFrame(response, { content: answerText(body) });
    writeFrame(response, {}, "stop");
  }
  response.end("data: [DONE]\n\n");
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

async function handleTwinChat(request, response, requests, behavior) {
  try {
    const body = await requestBody(request);
    requests.push({ stream: body.stream === true, hasStreamOptions: "stream_options" in body });
    if (body.stream === true && ("stream_options" in body || behavior.rejectAllStreams)) {
      sendJson(response, { error: { code: "unsupported_parameter" } }, 400);
      return;
    }
    if (body.stream === true) answerStream(response, body);
    else answerBuffered(response, body);
  } catch {
    sendJson(response, { error: { type: "invalid_request_error" } }, 400);
  }
}

function handleTwinRequest(request, response, requests, behavior) {
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
    if (
      request.headers["x-litellm-key"] !==
      apiKeyHeaderValue("x-litellm-key", CUSTOMER_SHAPE_API_KEY)
    ) {
      sendJson(response, { error: { type: "authentication_error" } }, 401);
      return;
    }
    void handleTwinChat(request, response, requests, behavior);
    return;
  }
  sendJson(response, { error: { type: "not_found" } }, 404);
}

export async function startCustomerShapeLiteLlmTwin() {
  const requests = [];
  const behavior = { rejectAllStreams: false };
  const server = createServer((request, response) =>
    handleTwinRequest(request, response, requests, behavior),
  );
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("twin did not bind");
  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
    requests,
    rejectAllStreaming: () => {
      behavior.rejectAllStreams = true;
    },
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
