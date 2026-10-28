import { ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { Socket } from "node:net";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createHostRuntimeService,
  createNamespaceRuntimeService,
  parseRuntimeLoopbackServiceEndpoint,
} from "./runtime-service.js";

afterEach(() => vi.restoreAllMocks());

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fixture-address");
  return address.port;
}

async function fixture(label = "owned-service"): Promise<{
  readonly port: number;
  readonly output: PassThrough;
  readonly errorOutput: PassThrough;
  readonly errors: ReturnType<typeof vi.fn>;
  readonly host: ReturnType<typeof createHostRuntimeService>;
  readonly receiver: ReturnType<typeof createNamespaceRuntimeService>;
  endpoint(): string | undefined;
  close(): Promise<void>;
}> {
  const server = createServer((request, response) => {
    if (request.headers.authorization !== "Basic fixture-service") {
      response.writeHead(401).end();
      return;
    }
    response.end(label);
  });
  const port = await listen(server);
  const output = new PassThrough();
  const errorOutput = new PassThrough();
  const errors = vi.fn();
  const receiver = createNamespaceRuntimeService(1, errors);
  const child = new ChildProcess();
  Object.defineProperties(child, {
    stdout: { value: output },
    stderr: { value: errorOutput },
    send: {
      value: (
        message: unknown,
        socket: unknown,
        callback: (error: Error | null) => void,
      ): boolean => {
        receiver.receive(message, socket);
        callback(null);
        return true;
      },
    },
  });
  const written: string[] = [];
  const host = createHostRuntimeService(child, 1, errors, (_output, line) => {
    written.push(line);
  });
  return {
    port,
    output,
    errorOutput,
    errors,
    host,
    receiver,
    endpoint: (): string | undefined =>
      written
        .map((line) => parseRuntimeLoopbackServiceEndpoint(line))
        .find((value) => value !== undefined),
    close: async (): Promise<void> => {
      receiver.close();
      await host.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      );
    },
  };
}

describe("the original runtime's private namespace service route", () => {
  it("bounds pending bytes across both producer streams together", async () => {
    const f = await fixture();
    try {
      f.host.ready();
      f.output.write("x".repeat(40_000));
      expect(f.errors).not.toHaveBeenCalled();
      f.errorOutput.write("y".repeat(40_000));
      expect(f.errors).toHaveBeenCalledOnce();
      expect(f.endpoint()).toBeUndefined();
    } finally {
      await f.close();
    }
  });

  it("keeps concurrent runtime services bound to their own namespace receivers", async () => {
    const first = await fixture("first-owned-service");
    const second = await fixture("second-owned-service");
    try {
      for (const current of [first, second]) {
        current.host.ready();
        current.output.write(`server listening on http://127.0.0.1:${String(current.port)}\n`);
        await vi.waitFor(() => {
          expect(current.endpoint()).toBeDefined();
        });
      }
      const endpoints = [first.endpoint(), second.endpoint()];
      expect(endpoints[0]).not.toBe(endpoints[1]);
      const bodies = await Promise.all(
        endpoints.map(async (endpoint) => {
          if (endpoint === undefined) throw new Error("fixture-endpoint");
          const response = await fetch(endpoint, {
            headers: { Authorization: "Basic fixture-service" },
          });
          return await response.text();
        }),
      );
      expect(bodies).toEqual(["first-owned-service", "second-owned-service"]);
      expect(first.errors).not.toHaveBeenCalled();
      expect(second.errors).not.toHaveBeenCalled();
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });

  it("waits for the owned namespace handshake, preserves authentication and closes after reap", async () => {
    const f = await fixture();
    let endpoint: string | undefined;
    try {
      f.output.write(`server listening on http://127.0.0.1:${String(f.port)}\n`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(f.endpoint()).toBeUndefined();
      f.host.ready();
      await vi.waitFor(() => {
        expect(f.endpoint()).toBeDefined();
      });
      endpoint = f.endpoint();
      if (endpoint === undefined) throw new Error("fixture-endpoint");
      expect(new URL(endpoint).port).not.toBe(String(f.port));
      expect((await fetch(endpoint)).status).toBe(401);
      const response = await fetch(endpoint, {
        headers: { Authorization: "Basic fixture-service" },
      });
      expect(await response.text()).toBe("owned-service");
      expect(f.errors).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
    await expect(fetch(endpoint)).rejects.toThrow();
  });

  it.each(["same", "different"] as const)(
    "refuses a second %s service announcement",
    async (kind) => {
      const f = await fixture();
      try {
        f.host.ready();
        f.output.write(`server listening on http://127.0.0.1:${String(f.port)}\n`);
        await vi.waitFor(() => {
          expect(f.endpoint()).toBeDefined();
        });
        const port = kind === "same" ? f.port : 2;
        f.output.write(`server listening on http://127.0.0.1:${String(port)}\n`);
        await vi.waitFor(() => {
          expect(f.errors).toHaveBeenCalledOnce();
        });
      } finally {
        await f.close();
      }
    },
  );

  it("rejects the gateway itself and bounds queued producer output", async () => {
    for (const line of ["server listening on http://127.0.0.1:1\n", "x".repeat(65537)]) {
      const f = await fixture();
      try {
        f.host.ready();
        f.output.write(line);
        await vi.waitFor(() => {
          expect(f.errors).toHaveBeenCalledOnce();
        });
        expect(f.endpoint()).toBeUndefined();
      } finally {
        await f.close();
      }
    }
  });

  it.each([
    "server listening on http://example.test:1234\n",
    "server listening on http://127.0.0.1:0\n",
    "server listening on http://127.0.0.1:65536\n",
    "server listening on http://127.0.0.1:1234/path\n",
    '{"url":"http://127.0.0.1:1234","target":"elsewhere"}\n',
  ])("does not interpret malformed or nonlocal output as service authority: %s", (line) => {
    expect(parseRuntimeLoopbackServiceEndpoint(line)).toBeUndefined();
  });

  it("rejects replayed connection ids, changed destinations and invalid socket handles", async () => {
    const f = await fixture();
    try {
      f.host.ready();
      f.output.write(`server listening on http://127.0.0.1:${String(f.port)}\n`);
      await vi.waitFor(() => {
        expect(f.endpoint()).toBeDefined();
      });
      const endpoint = f.endpoint();
      if (endpoint === undefined) throw new Error("fixture-endpoint");
      await fetch(endpoint);
      for (const [connectionId, port, socket] of [
        [1, f.port, new Socket()],
        [2, 2, new Socket()],
        [3, f.port, undefined],
      ] as const) {
        expect(f.receiver.receive({ kind: "service-socket", connectionId, port }, socket)).toBe(
          true,
        );
        if (socket !== undefined) expect(socket.destroyed).toBe(true);
      }
      expect(f.errors).toHaveBeenCalledTimes(3);
      expect(
        f.receiver.receive(
          { kind: "service-socket", connectionId: 4, port: f.port, extra: true },
          new Socket(),
        ),
      ).toBe(false);
    } finally {
      await f.close();
    }
  });
});
