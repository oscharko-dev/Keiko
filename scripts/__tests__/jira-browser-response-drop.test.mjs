import { createServer } from "node:http";
import { Buffer } from "node:buffer";
import { afterEach, expect, it, vi } from "vitest";
import { dropCommittedBrowserCompletion } from "../testing/jira-chat-lab/browser-response-drop.mjs";

const servers = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

async function fixture(turnState = "completed", path = "/api/desktop/chat/stream") {
  const messages = [
    { id: "human", chatId: "chat", role: "user", turnState, content: "Synthetic request" },
    {
      id: "answer",
      chatId: "chat",
      role: "assistant",
      content: "Confirmed synthetic change",
      responseVersion: 1,
    },
  ];
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const committed = vi.fn();
  const fault = dropCommittedBrowserCompletion(() => "chat", committed);
  const server = createServer(async (_request, response) => {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const state of ["pending", "granted"])
      response.write(
        frame("tool-read-consent", { messageId: "human", grant: { chatId: "chat", state } }),
      );
    for (const state of ["pending", "approved", "claimed"])
      response.write(frame("tool-write-approval", { messageId: "human", approval: { state } }));
    await pending;
    response.write(frame("done", { chat: { id: "chat" }, messages }));
    response.end();
  });
  servers.push(server);
  fault.configureServer({
    server,
    store: { findMessageById: (id) => messages.find((message) => message.id === id) },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const response = await globalThis.fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method: "POST",
  });
  const reader = response.body.getReader();
  let received = "";
  while (!received.includes('"state":"claimed"')) {
    const part = await reader.read();
    expect(part.done).toBe(false);
    received += Buffer.from(part.value).toString("utf8");
  }
  return { fault, committed, reader, release, received };
}

it("physically interrupts the real HTTP stream after delivered approvals and durable completion", async () => {
  const f = await fixture();
  f.release();
  await expect(f.reader.read()).rejects.toThrow();
  expect(f.received).toContain("event: tool-read-consent");
  expect(f.received).not.toContain("event: done");
  expect(f.committed).toHaveBeenCalledOnce();
  f.fault.assertDropped();
  expect(f.fault.snapshot()).toMatchObject({
    drops: 1,
    grants: 1,
    approvals: 1,
    readStateFrames: 2,
    approvalStateFrames: 3,
    witnessFailures: 0,
  });
});

it("cannot qualify a premature done frame as an interrupted committed write", async () => {
  const f = await fixture("pending");
  f.release();
  await expect(f.reader.read()).rejects.toThrow();
  expect(f.committed).not.toHaveBeenCalled();
  expect(() => f.fault.assertDropped()).toThrow();
  expect(f.fault.snapshot()).toMatchObject({ drops: 0, witnessFailures: 1 });
});

it("does not interrupt a different endpoint", async () => {
  const f = await fixture("completed", "/unrelated-stream");
  f.release();
  const part = await f.reader.read();
  expect(Buffer.from(part.value).toString("utf8")).toContain("event: done");
  expect((await f.reader.read()).done).toBe(true);
  expect(f.committed).not.toHaveBeenCalled();
  expect(f.fault.snapshot().drops).toBe(0);
});
