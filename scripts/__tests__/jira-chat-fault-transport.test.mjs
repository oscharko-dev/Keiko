import { describe, expect, it, vi } from "vitest";
import { observedMutationFault } from "../testing/jira-chat-lab/chat-fault-transport.mjs";

const target = {
  method: "PUT",
  path: "/rest/api/2/issue/SYN-1",
  body: { fields: { summary: "Synthetic" } },
};
const mutation = {
  method: target.method,
  url: `https://synthetic.invalid${target.path}`,
  bodyJson: JSON.stringify(target.body),
};

function fixture(fault, responseStatus = 204) {
  const effects = [];
  const beforeDispatch = vi.fn(() => true);
  const onResponse = vi.fn(() => true);
  const observer = observedMutationFault(target, fault);
  const port = observer.decorate((_metadata, _correlation, lifecycle) => async (request) => {
    if (lifecycle.beforeDispatch(request) !== true) throw new TypeError("Admission failed");
    if (request.method !== "GET") effects.push(request);
    lifecycle.onResponse(request, responseStatus);
    return {
      kind: "response",
      status: responseStatus,
      bodyText: "",
      bodyBytes: 0,
      truncated: false,
    };
  })({}, "synthetic", { beforeDispatch, onResponse });
  return { port, observer, effects, beforeDispatch, onResponse };
}

describe("real-port mutation observation fault", () => {
  it("guards a confirmed effect while preserving the real Jira acknowledgement without injection", async () => {
    const f = fixture("none");
    expect(await f.port(mutation)).toMatchObject({ kind: "response", status: 204 });
    expect(f.onResponse).toHaveBeenCalledWith(mutation, 204);
    expect(f.observer.snapshot()).toEqual({
      attempts: 1,
      forwarded: 1,
      injected: 0,
      actualStatus: 204,
    });
    await expect(f.port(mutation)).rejects.toThrow("repeated mutation");
    expect(f.effects).toHaveLength(1);
  });

  it.each(["lost-response", "committed-503"])(
    "keeps admission and one real effect for %s",
    async (fault) => {
      const f = fixture(fault);
      const result = await f.port(mutation);
      expect(f.beforeDispatch).toHaveBeenCalledWith(mutation);
      expect(f.effects).toEqual([mutation]);
      expect(f.observer.snapshot()).toEqual({
        attempts: 1,
        forwarded: 1,
        injected: 1,
        actualStatus: 204,
      });
      if (fault === "lost-response") {
        expect(f.onResponse).not.toHaveBeenCalled();
        expect(result).toEqual({ kind: "network-error" });
      } else {
        expect(f.onResponse).toHaveBeenCalledWith(mutation, 503);
        expect(result).toMatchObject({ kind: "response", status: 503 });
      }
      await expect(f.port(mutation)).rejects.toThrow("repeated mutation");
      expect(f.effects).toHaveLength(1);
      expect(f.observer.snapshot().attempts).toBe(2);
    },
  );

  it("preserves reads and actual non-success responses without manufacturing a successful effect", async () => {
    const f = fixture("lost-response", 403);
    const read = { method: "GET", url: mutation.url };
    expect(await f.port(read)).toMatchObject({ status: 403 });
    expect(await f.port(mutation)).toMatchObject({ status: 403 });
    expect(f.onResponse).toHaveBeenCalledWith(mutation, 403);
    expect(f.observer.snapshot().injected).toBe(0);
  });

  it("blocks an unexpected mutation before the real transport", async () => {
    const f = fixture("lost-response");
    await expect(f.port({ ...mutation, bodyJson: "{}" })).rejects.toThrow();
    expect(f.effects).toEqual([]);
    expect(f.beforeDispatch).not.toHaveBeenCalled();
  });

  it("preserves production authority denial before any real effect", async () => {
    const f = fixture("lost-response");
    f.beforeDispatch.mockReturnValue(false);
    await expect(f.port(mutation)).rejects.toThrow("Admission failed");
    expect(f.effects).toEqual([]);
    expect(f.observer.snapshot().injected).toBe(0);
  });

  it("retains the external guard across a fresh application process", async () => {
    const observer = observedMutationFault(target, "lost-response", {
      attempts: 1,
      forwarded: 1,
      injected: 1,
      actualStatus: 201,
    });
    const underlying = vi.fn();
    const port = observer.decorate(() => underlying)({}, "restart", {});
    await expect(port(mutation)).rejects.toThrow("repeated mutation");
    expect(underlying).not.toHaveBeenCalled();
    expect(observer.snapshot().attempts).toBe(2);
  });
});
