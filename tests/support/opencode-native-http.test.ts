import {
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
  Server,
  createServer,
} from "node:http";
import { spawn } from "node:child_process";
import {
  assertNativeCleanupFailure,
  stopNativeChild,
  withNativeChild,
} from "./opencode-native-child.js";
import { describe, expect, it, vi } from "vitest";
import {
  closeNativeHttpStub,
  startNativeHttpStub,
  startNativeHttpByteListener,
  parseNativeHttpJson,
  withNativeHttpStub,
  type NativeHttpStub,
  type NativeHttpListener,
} from "./opencode-native-http.js";

function url(stub: NativeHttpListener, path: string): string {
  return `http://127.0.0.1:${String(stub.port)}${path}`;
}

function pendingPost(target: string): {
  readonly request: ClientRequest;
  readonly status: Promise<number | Error>;
} {
  const request = httpRequest(target, { method: "POST" });
  const status = new Promise<number | Error>((resolve) => {
    request.once("response", (response) => {
      response.resume();
      response.once("end", () => {
        resolve(response.statusCode ?? 0);
      });
    });
    request.once("error", resolve);
  });
  return { request, status };
}

async function assertNestedCleanupFailure(
  outer: NativeHttpStub,
  inner: NativeHttpStub,
): Promise<void> {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const order: string[] = [];
    child.once("exit", () => {
      order.push("child");
    });
    outer.server.once("close", () => {
      order.push("outer-listener");
    });
    const primary: Error = Object.freeze(new TypeError("fixture-body-refused"));
    const cleanup: Error = Object.freeze(new TypeError("fixture-inner-close-refused"));
    const close = vi.spyOn(inner.server, "close").mockImplementationOnce((): never => {
      order.push("inner-listener");
      throw cleanup;
    });
    try {
      const failed = withNativeHttpStub(outer, async (): Promise<void> => {
        await withNativeHttpStub(inner, async (): Promise<void> => {
          await withNativeChild(child, (): Promise<void> => Promise.reject(primary));
        });
      });
      const failure: unknown = await failed.catch((error: unknown): unknown => error);
      assertNativeCleanupFailure(failure, primary, cleanup);
      expect(order).toEqual(["child", "inner-listener", "outer-listener"]);
      expect(outer.server.listening).toBe(false);
    } finally {
      close.mockRestore();
    }
  } finally {
    await stopNativeChild(child);
  }
}

function recordByteView(
  view: "body" | "url-body",
  request: IncomingMessage,
  bytes: Buffer,
): { readonly body: unknown; readonly url?: string } {
  if (view === "body") return { body: parseNativeHttpJson(bytes.toString("utf8")) };
  return { url: request.url ?? "", body: parseNativeHttpJson(bytes.toString("utf8")) };
}

function observeByteViewHeaders(request: IncomingMessage, reads: string[]): void {
  Object.defineProperty(request, "url", {
    get: (): string => {
      reads.push("url");
      return "/projected";
    },
  });
  Object.defineProperty(request.headers, "authorization", {
    get: (): undefined => {
      reads.push("authorization");
      return undefined;
    },
  });
}

describe("native fixture HTTP recorder resources", () => {
  it("records JSON, original text and empty bodies with exact keys and append-before-response ordinals", async (): Promise<void> => {
    const ordinals: number[] = [];
    const stub = await startNativeHttpStub((self, recorded, response) => {
      ordinals.push(self.requests.length);
      response.end(JSON.stringify(recorded.body));
    });
    try {
      const json = await fetch(url(stub, "/json?test=1"), {
        method: "POST",
        headers: { Authorization: "fixture-token" },
        body: '{"value":7}',
      });
      expect(await json.json()).toEqual({ value: 7 });
      const text = await fetch(url(stub, "/text"), { method: "POST", body: "not-json" });
      expect(await text.json()).toBe("not-json");
      const empty = await fetch(url(stub, "/empty"), { method: "POST" });
      expect(await empty.json()).toBe("");
      expect(stub.requests).toEqual([
        { url: "/json?test=1", authorization: "fixture-token", body: { value: 7 } },
        { url: "/text", authorization: undefined, body: "not-json" },
        { url: "/empty", authorization: undefined, body: "" },
      ]);
      expect(Object.keys(stub.requests[1] ?? {})).toEqual(["url", "authorization", "body"]);
      expect(ordinals).toEqual([1, 2, 3]);
    } finally {
      await closeNativeHttpStub(stub);
    }
    expect(stub.server.listening).toBe(false);
  });

  it("captures URL and authorization only after the complete body, in completed-body order", async (): Promise<void> => {
    const stub = await startNativeHttpStub((_self, _recorded, response) => {
      response.end();
    });
    const reads: string[] = [];
    const seen = new Promise<void>((resolve) => {
      stub.server.prependOnceListener("request", (request) => {
        Object.defineProperty(request, "url", {
          get: (): string => {
            reads.push("url");
            return "/slow";
          },
        });
        Object.defineProperty(request.headers, "authorization", {
          get: (): undefined => {
            reads.push("authorization");
            return undefined;
          },
        });
        resolve();
      });
    });
    const slow = pendingPost(url(stub, "/slow"));
    try {
      slow.request.flushHeaders();
      await seen;
      expect(stub.requests).toEqual([]);
      expect(reads).toEqual([]);
      const fast = await fetch(url(stub, "/fast"), { method: "POST", body: "2" });
      await fast.text();
      slow.request.end("1");
      expect(await slow.status).toBe(200);
      expect(stub.requests.map((entry) => entry.url)).toEqual(["/fast", "/slow"]);
      expect(reads).toEqual(["url", "authorization"]);
    } finally {
      slow.request.destroy();
      await closeNativeHttpStub(stub);
    }
  });

  it("accepts exactly four MiB and refuses a larger body before recording or responding locally", async (): Promise<void> => {
    let calls = 0;
    const stub = await startNativeHttpStub((_self, _recorded, response) => {
      calls += 1;
      response.end();
    });
    try {
      const exact = await fetch(url(stub, "/exact"), {
        method: "POST",
        body: "x".repeat(4 * 1_024 * 1_024),
      });
      await exact.text();
      expect(exact.status).toBe(200);
      let refused: boolean;
      try {
        const excess = await fetch(url(stub, "/oversized"), {
          method: "POST",
          body: "x".repeat(4 * 1_024 * 1_024 + 1),
        });
        await excess.text();
        refused = excess.status === 500;
      } catch {
        refused = true;
      }
      expect(refused).toBe(true);
      expect(calls).toBe(1);
      expect(stub.requests).toHaveLength(1);
    } finally {
      await closeNativeHttpStub(stub);
    }
  });

  it("keeps recorded evidence when a local response script throws", async (): Promise<void> => {
    const failure: Error = Object.freeze(new TypeError("fixture-response-refusal"));
    const stub = await startNativeHttpStub(() => {
      throw failure;
    });
    try {
      const response = await fetch(url(stub, "/refused"), { method: "POST", body: "false" });
      expect(response.status).toBe(500);
      expect(stub.requests).toEqual([{ url: "/refused", authorization: undefined, body: false }]);
    } finally {
      await closeNativeHttpStub(stub);
    }
  });

  it("isolates concurrent fixture state and disposes a held response through the real connection", async (): Promise<void> => {
    const held = await startNativeHttpStub((_self, _recorded, response) => {
      response.write(": held\n");
    });
    try {
      const other = await startNativeHttpStub((_self, _recorded, response) => {
        response.end();
      });
      try {
        const response = await fetch(url(held, "/held"), { method: "POST", body: "1" });
        const drained = response.text();
        const rejection = expect(drained).rejects.toThrow();
        const healthy = await fetch(url(other, "/healthy"), { method: "POST", body: "2" });
        await healthy.text();
        expect(held.requests.map((entry) => entry.body)).toEqual([1]);
        expect(other.requests.map((entry) => entry.body)).toEqual([2]);
        await closeNativeHttpStub(held);
        await rejection;
      } finally {
        await closeNativeHttpStub(other);
      }
    } finally {
      if (held.server.listening) await closeNativeHttpStub(held);
    }
  });

  it("closes an acquired listener if startup cannot publish a valid address", async (): Promise<void> => {
    const address = vi.spyOn(Server.prototype, "address").mockReturnValueOnce(null);
    const close = vi.spyOn(Server.prototype, "close");
    try {
      await expect(
        startNativeHttpStub((_self, _recorded, response) => {
          response.end();
        }),
      ).rejects.toThrow("fixture-listener-invalid");
      expect(close).toHaveBeenCalledOnce();
    } finally {
      address.mockRestore();
      close.mockRestore();
    }
  });

  it("closes the listener after a productive body completes", async (): Promise<void> => {
    const stub = await startNativeHttpStub((_self, _recorded, response) => {
      response.end();
    });
    const statuses: number[] = [];
    try {
      await withNativeHttpStub(stub, async (): Promise<void> => {
        const response = await fetch(url(stub, "/healthy"));
        statuses.push(response.status);
        await response.text();
      });
      expect(statuses).toEqual([200]);
      expect(stub.server.listening).toBe(false);
    } finally {
      if (stub.server.listening) await closeNativeHttpStub(stub);
    }
  });

  it("disposes an earlier listener when a later resource acquisition rejects", async (): Promise<void> => {
    const stub = await startNativeHttpStub((_self, _recorded, response) => {
      response.end();
    });
    const primary: Error = Object.freeze(new TypeError("fixture-next-listener-refused"));
    try {
      await expect(
        withNativeHttpStub(stub, (): Promise<void> => Promise.reject(primary)),
      ).rejects.toBe(primary);
      expect(stub.server.listening).toBe(false);
    } finally {
      if (stub.server.listening) await closeNativeHttpStub(stub);
    }
  });

  it("retains both listener failure identities without hiding the primary failure", async (): Promise<void> => {
    const stub = await startNativeHttpStub((_self, _recorded, response) => {
      response.end();
    });
    const primary: Error = Object.freeze(new TypeError("fixture-primary-refused"));
    const cleanup: Error = Object.freeze(new TypeError("fixture-close-refused"));
    const close = vi.spyOn(stub.server, "close").mockImplementationOnce((): never => {
      throw cleanup;
    });
    try {
      const failure: unknown = await withNativeHttpStub(stub, (): Promise<void> =>
        Promise.reject(primary),
      ).then(
        (): undefined => undefined,
        (error: unknown): unknown => error,
      );
      assertNativeCleanupFailure(failure, primary, cleanup);
      expect(stub.server.listening).toBe(true);
    } finally {
      close.mockRestore();
      await closeNativeHttpStub(stub);
    }
  });

  it("attempts nested cleanup in child-then-listener order even when inner cleanup fails", async (): Promise<void> => {
    const outer = await startNativeHttpStub((_self, _recorded, response) => {
      response.end();
    });
    try {
      const inner = await startNativeHttpStub((_self, _recorded, response) => {
        response.end();
      });
      try {
        await assertNestedCleanupFailure(outer, inner);
      } finally {
        if (inner.server.listening) await closeNativeHttpStub(inner);
      }
    } finally {
      if (outer.server.listening) await closeNativeHttpStub(outer);
    }
  });
});

describe("native fixture byte-listener projections", () => {
  it.each(["body", "url-body"] as const)(
    "retains the exact %s view and defers its header observations until the body completes",
    async (view): Promise<void> => {
      const listener: NativeHttpListener = { server: createServer(), port: 0 };
      const records: unknown[] = [];
      const reads: string[] = [];
      await startNativeHttpByteListener(listener, (request, bytes, response) => {
        records.push(recordByteView(view, request, bytes));
        response.end();
      });
      try {
        const headers = new Promise<void>((resolve) => {
          listener.server.prependOnceListener("request", (request) => {
            observeByteViewHeaders(request, reads);
            resolve();
          });
        });
        const pending = pendingPost(url(listener, "/projected"));
        try {
          pending.request.flushHeaders();
          await headers;
          expect(records).toEqual([]);
          expect(reads).toEqual([]);
          pending.request.end('{"value":7}');
          expect(await pending.status).toBe(200);
          expect(records).toStrictEqual(
            view === "body"
              ? [{ body: { value: 7 } }]
              : [{ url: "/projected", body: { value: 7 } }],
          );
          expect(reads).toEqual(view === "body" ? [] : ["url"]);
        } finally {
          pending.request.destroy();
        }
      } finally {
        await closeNativeHttpStub(listener);
      }
    },
  );
});
