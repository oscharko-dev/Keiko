import assert from "node:assert/strict";
import { URL } from "node:url";

const FAULTS = new Set(["lost-response", "committed-503"]);
function originalResponse(lifecycle, request, status) {
  return lifecycle?.onResponse?.(request, status) ?? true;
}

/**
 * Qualification-only observation fault. The original production port still sends the real
 * request, materializes the credential, checks TLS/egress and invokes beforeDispatch. After
 * real 2xx headers, only the journal-visible acknowledgement/result are changed. Transport
 * logs therefore truthfully retain the actual status; this is not a physical network fault.
 */
export function observedMutationFault(target, fault, initial = {}) {
  assert.ok(FAULTS.has(fault));
  const state = { attempts: 0, forwarded: 0, injected: 0, actualStatus: 0, ...initial };
  function admit(request) {
    state.attempts += 1;
    // A regression must fail safely instead of creating a second real Jira mutation.
    assert.equal(state.attempts, 1, "Qualification blocked a repeated mutation attempt");
    assert.equal(request.method, target.method);
    assert.ok(new URL(request.url).pathname.endsWith(target.path));
    assert.deepEqual(JSON.parse(request.bodyJson), target.body);
    state.forwarded += 1;
  }
  function response(lifecycle, request, status) {
    if (request.method === "GET" || status < 200 || status >= 300)
      return originalResponse(lifecycle, request, status);
    state.actualStatus = status;
    state.injected += 1;
    assert.equal(state.injected, 1);
    return fault === "lost-response" ? true : originalResponse(lifecycle, request, 503);
  }
  const decorate = (factory) => (metadata, correlationId, lifecycle) => {
    const port = factory(metadata, correlationId, {
      ...lifecycle,
      onResponse: (request, status) => response(lifecycle, request, status),
    });
    return async (request) => {
      if (request.method !== "GET") admit(request);
      const observed = await port(request);
      if (
        request.method === "GET" ||
        observed.kind !== "response" ||
        observed.status < 200 ||
        observed.status >= 300
      )
        return observed;
      assert.equal(state.injected, 1, "Production response lifecycle must have run");
      return fault === "lost-response"
        ? { kind: "network-error" }
        : { kind: "response", status: 503, bodyText: "{}", bodyBytes: 2, truncated: false };
    };
  };
  return { decorate, snapshot: () => ({ ...state }) };
}
