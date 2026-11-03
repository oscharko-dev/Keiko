// Deterministic wire fixtures only. The BFF retains its production HTTP, gateway,
// catalog, MCP, credential, authority, approval and durable mutation owners.
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

export const FIXTURE_PAT = "synthetic-jira-browser-fixture-pat";
export const COMMENT_BODY = "Synthetic browser approval fixture";

async function bodyOf(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) throw new TypeError("Fixture request exceeds its bound");
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw.length === 0 ? {} : JSON.parse(raw);
}

function json(response, status, value) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function metricsOwner(directory) {
  const path = join(directory, "metrics.json");
  const counts = {
    models: 0,
    jiraRequests: 0,
    projects: 0,
    writes: 0,
    confirmations: 0,
    denied: 0,
    leaks: 0,
  };
  const persist = () => {
    writeFileSync(`${path}.tmp`, JSON.stringify(counts), { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
  };
  persist();
  return { counts, persist };
}

function certificate(directory) {
  const key = join(directory, "fixture-key.pem");
  const cert = join(directory, "fixture-ca.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
      "-keyout",
      key,
      "-out",
      cert,
    ],
    { stdio: "ignore" },
  );
  return { key: readFileSync(key), cert: readFileSync(cert), caPath: cert };
}

function jiraHandler(observation, baseUrl) {
  return async (request, response) => {
    observation.counts.jiraRequests++;
    observation.persist();
    const path = new URL(request.url, baseUrl).pathname;
    if (request.headers.authorization !== `Bearer ${FIXTURE_PAT}`) {
      observation.counts.denied++;
      observation.persist();
      return json(response, 401, { errorMessages: ["Synthetic denied identity"] });
    }
    if (path === "/jira/rest/api/2/serverInfo" && request.method === "GET") {
      return json(response, 200, {
        baseUrl,
        version: "10.3.26",
        versionNumbers: [10, 3, 26],
        deploymentType: "Server",
      });
    }
    if (path === "/jira/rest/api/2/myself" && request.method === "GET") {
      return json(response, 200, {
        name: "synthetic-reader",
        key: "synthetic-reader-key",
        displayName: "Synthetic reader",
        active: true,
      });
    }
    if (path === "/jira/rest/api/2/project" && request.method === "GET") {
      observation.counts.projects++;
      observation.persist();
      return json(response, 200, [{ id: "10000", key: "KEIKO", name: "Synthetic project" }]);
    }
    return commentRoute(request, response, path, observation);
  };
}

async function commentRoute(request, response, path, observation) {
  if (path === "/jira/rest/api/2/issue/KEIKO-1/comment" && request.method === "POST") {
    const body = await bodyOf(request);
    if (body.body !== COMMENT_BODY)
      return json(response, 400, { errorMessages: ["Unexpected fixture action"] });
    observation.counts.writes++;
    observation.persist();
    return json(response, 201, { id: String(observation.counts.writes), body: COMMENT_BODY });
  }
  if (
    request.method === "GET" &&
    /^\/jira\/rest\/api\/2\/issue\/KEIKO-1\/comment\/\d+$/u.test(path)
  ) {
    observation.counts.confirmations++;
    observation.persist();
    return json(response, 200, { id: path.split("/").at(-1), body: COMMENT_BODY });
  }
  return json(response, 404, { errorMessages: ["Fixture operation is not implemented"] });
}

function lastTurn(messages) {
  let offset = 0;
  for (let index = 0; index < messages.length; index++) {
    if (messages[index].role === "user") offset = index;
  }
  return messages.slice(offset);
}

function modelMessage(body, observation) {
  if (JSON.stringify(body).includes(FIXTURE_PAT)) {
    observation.counts.leaks++;
    observation.persist();
  }
  const tools = Array.isArray(body.tools) ? body.tools : [];
  if (tools.some((tool) => tool.function?.name === "report_readiness")) {
    return toolMessage("report_readiness", { status: "ok" }, "readiness");
  }
  const messages = lastTurn(Array.isArray(body.messages) ? body.messages : []);
  const prompt = JSON.stringify(messages);
  if (!prompt.includes("JIRA_E2E_")) return { role: "assistant", content: "Ready." };
  if (messages.some((message) => message.role === "tool")) {
    return { role: "assistant", content: "JIRA_E2E_DONE" };
  }
  const write = prompt.includes("JIRA_E2E_COMMENT");
  const name = write ? "jira_comment" : "jira_projects";
  if (!tools.some((tool) => tool.function?.name === name)) {
    throw new TypeError("Expected governed catalog projection was not offered");
  }
  return toolMessage(
    name,
    write ? { issueKey: "KEIKO-1", body: COMMENT_BODY } : {},
    String(observation.counts.models),
  );
}

function toolMessage(name, args, id) {
  return {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: `fixture-${id}`,
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  };
}

function completion(response, body, message) {
  const finish = message.tool_calls === undefined ? "stop" : "tool_calls";
  const base = { id: "fixture-completion", created: 0, model: body.model };
  const usage = { prompt_tokens: 32, completion_tokens: 16, total_tokens: 48 };
  if (body.stream !== true) {
    return json(response, 200, {
      ...base,
      object: "chat.completion",
      choices: [{ index: 0, message, finish_reason: finish }],
      usage,
    });
  }
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const delta = {
    ...message,
    ...(message.tool_calls
      ? { tool_calls: message.tool_calls.map((call, index) => ({ ...call, index })) }
      : {}),
  };
  response.write(
    `data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
  );
  response.write(
    `data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: finish }], usage })}\n\n`,
  );
  response.end("data: [DONE]\n\n");
}

function guarded(handler) {
  return (request, response) => {
    void Promise.resolve(handler(request, response)).catch(() =>
      json(response, 500, { error: "Synthetic fixture failed" }),
    );
  };
}

async function listen(server, port) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
}

export async function startJiraChatTransports(directory, jiraPort, modelPort) {
  const tls = certificate(directory);
  const observation = metricsOwner(directory);
  const baseUrl = `https://127.0.0.1:${jiraPort}/jira`;
  const jira = createHttpsServer(tls, guarded(jiraHandler(observation, baseUrl)));
  const model = createHttpServer(
    guarded(async (request, response) => {
      observation.counts.models++;
      observation.persist();
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
        return json(response, 404, { error: "Unsupported synthetic model route" });
      }
      const body = await bodyOf(request);
      completion(response, body, modelMessage(body, observation));
    }),
  );
  await listen(jira, jiraPort);
  await listen(model, modelPort);
  return {
    caPath: tls.caPath,
    baseUrl,
    close: () => {
      jira.closeAllConnections();
      model.closeAllConnections();
      jira.close();
      model.close();
    },
  };
}
