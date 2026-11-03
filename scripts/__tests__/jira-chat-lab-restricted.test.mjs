import { describe, expect, it, vi } from "vitest";
import {
  focusedRestrictedCases,
  restrictedDispatchObserver,
  restrictedCaseAtDispatch,
  verifyRestrictedTurn,
} from "../testing/jira-chat-lab/restricted-cases.mjs";
import {
  restrictedReadExpectation,
  restrictedWriteCases,
} from "../testing/jira-chat-lab/restricted-catalog-cases.mjs";

const fixture = {
  issueKeys: ["KEIKO-1", "KEIKO-2", "KEIKO-3"],
  isolationIssueKey: "ISOLATED-1",
  requiredFieldId: "customfield_10000",
  issueTypeId: "10000",
};
const transition = {
  id: "31",
  fields: { resolution: { allowedValues: [{ id: "1" }] } },
};
const cases = focusedRestrictedCases(fixture, "10000", transition, "group");
function observedCase(testCase, transport = "buffered") {
  const mutation = testCase.operation !== "jira.issue";
  const approvals = mutation ? 1 : 0;
  const data = { outcome: testCase.outcome };
  if (testCase.outcome !== "succeeded")
    data.reason =
      testCase.id === "editor-transition-refused" ? "invalid-transition" : "field-validation";
  else if (!mutation) data.items = [{ key: testCase.arguments.issueKey }];
  const exchange = {
    call: {
      id: "call",
      name: testCase.operation.replace(/[.-]/gu, "_"),
      arguments: structuredClone(testCase.arguments),
    },
    result: {
      invocationId: "invocation",
      status: testCase.outcome === "succeeded" ? "completed" : "failed",
      data,
      reason: "provider-reported-error",
    },
    ...(mutation ? { mutationOutcome: testCase.outcome } : {}),
  };
  return {
    completed: {
      messages: [
        {
          id: "user",
          role: "user",
          turnState: "completed",
          toolTranscript: { exchanges: [exchange] },
        },
      ],
    },
    decisions: { grants: 1, approvals },
    events: new Set(
      transport === "stream"
        ? ["tool-read-consent", ...(approvals ? ["tool-write-approval"] : [])]
        : [],
    ),
  };
}
function dispatch(testCase) {
  return {
    attempts: testCase.dispatches,
    forwarded: testCase.dispatches,
    status: testCase.statuses?.[0] ?? 0,
  };
}
function exchange(observed) {
  return observed.completed.messages[0].toolTranscript.exchanges[0];
}

describe("restricted real-Chat qualification assertions", () => {
  it("separates permission refusal from missing required-field validation", () => {
    expect(cases).toHaveLength(8);
    expect(new Set(cases.map((item) => item.id)).size).toBe(8);
    const denied = cases.find((item) => item.id === "editor-transition-refused");
    expect(denied.arguments.fields[fixture.requiredFieldId]).toBeDefined();
    const omitted = cases.filter((item) => item.requiredFieldRefusal);
    expect(omitted).toHaveLength(2);
    for (const item of omitted) {
      expect(item.arguments.fields[fixture.requiredFieldId]).toBeUndefined();
      expect(item.dispatches).toBe(0);
      expect(item.outcome).toBe("rejected");
    }
  });

  for (const transport of ["buffered", "stream"])
    it.each(cases)(`accepts the exact observed case through ${transport}: $id`, (testCase) => {
      expect(() =>
        verifyRestrictedTurn(
          observedCase(testCase, transport),
          testCase,
          transport,
          dispatch(testCase),
        ),
      ).not.toThrow();
    });

  it.each([
    [
      "missing initial read consent",
      (observed) => {
        observed.decisions.grants = 0;
      },
    ],
    [
      "missing exact mutation approval",
      (observed) => {
        observed.decisions.approvals = 0;
      },
    ],
    [
      "a second model invocation",
      (observed) => {
        observed.completed.messages[0].toolTranscript.exchanges.push(exchange(observed));
      },
    ],
    [
      "changed action arguments",
      (observed) => {
        exchange(observed).call.arguments.issueKey = "KEIKO-99";
      },
    ],
    [
      "claimed success instead of uncertainty",
      (observed) => {
        exchange(observed).mutationOutcome = "succeeded";
      },
    ],
    [
      "generic failure instead of observed refusal",
      (observed) => {
        exchange(observed).result.data.reason = "unavailable";
      },
    ],
  ])("rejects %s", (_name, change) => {
    const testCase = cases.find((item) => item.id === "isolated-comment-refused");
    const observed = observedCase(testCase);
    change(observed);
    expect(() =>
      verifyRestrictedTurn(observed, testCase, "buffered", dispatch(testCase)),
    ).toThrow();
  });

  it("accepts a local metadata refusal without inventing an approval", () => {
    const testCase = cases.find((item) => item.requiredFieldRefusal);
    const observed = observedCase(testCase, "stream");
    observed.decisions.approvals = 0;
    observed.events.delete("tool-write-approval");
    expect(() =>
      verifyRestrictedTurn(observed, testCase, "stream", dispatch(testCase)),
    ).not.toThrow();
  });

  it("refuses an attempted mutation even if the fixture guard blocked its remote effect", () => {
    const testCase = cases.find((item) => item.requiredFieldRefusal);
    expect(() =>
      verifyRestrictedTurn(observedCase(testCase), testCase, "buffered", {
        attempts: 1,
        forwarded: 0,
        status: 0,
      }),
    ).toThrow();
  });
});

describe("restricted qualification pass-through dispatch observation", () => {
  function transport() {
    const observer = restrictedDispatchObserver();
    const original = vi.fn(async () => ({ kind: "response", status: 403 }));
    const factory = vi.fn(() => original);
    const lifecycle = { beforeDispatch: vi.fn(() => true), onResponse: vi.fn(() => true) };
    const port = observer.decorate(factory)({ id: "credential" }, "correlation", lifecycle);
    return { observer, original, factory, lifecycle, port };
  }
  function request(testCase) {
    return {
      method: testCase.target.method,
      url: `https://127.0.0.1:18443${testCase.target.path}`,
      bodyJson: JSON.stringify(testCase.target.body),
    };
  }

  it("preserves the original custody lifecycle and limits an exact request to one dispatch", async () => {
    const f = transport();
    const testCase = cases.find((item) => item.id === "isolated-comment-refused");
    f.observer.arm(testCase);
    await expect(f.port(request(testCase))).resolves.toEqual({ kind: "response", status: 403 });
    expect(f.factory).toHaveBeenCalledWith({ id: "credential" }, "correlation", f.lifecycle);
    expect(f.observer.snapshot()).toEqual({ attempts: 1, forwarded: 1, status: 403 });
    await expect(f.port(request(testCase))).rejects.toThrow();
    expect(f.original).toHaveBeenCalledTimes(1);
  });

  it("blocks an unexpected target before any real HTTP request", async () => {
    const f = transport();
    const testCase = cases.find((item) => item.id === "isolated-comment-refused");
    f.observer.arm(testCase);
    await expect(
      f.port({ ...request(testCase), bodyJson: JSON.stringify({ body: "different action" }) }),
    ).rejects.toThrow();
    expect(f.original).not.toHaveBeenCalled();
    expect(f.observer.snapshot()).toEqual({ attempts: 1, forwarded: 0, status: 0 });
  });

  it("never forwards a mutation for a required-field refusal", async () => {
    const f = transport();
    f.observer.arm(cases.find((item) => item.requiredFieldRefusal));
    await expect(f.port({ method: "POST" })).rejects.toThrow();
    expect(f.original).not.toHaveBeenCalled();
  });
});

describe("restricted catalog oracle and certainty", () => {
  it("keeps empty editable metadata distinct from a hidden or forbidden endpoint", () => {
    expect(
      restrictedReadExpectation("jira.edit-fields", "id", { status: 200, value: { fields: {} } }),
    ).toEqual({
      outcome: "succeeded",
      referenceStatus: 200,
      readExpected: { field: "id", values: [] },
    });
    expect(restrictedReadExpectation("jira.edit-fields", "id", { status: 403 })).toEqual({
      outcome: "failed",
      referenceStatus: 403,
      reasons: ["permission-denied"],
    });
    expect(restrictedReadExpectation("jira.edit-fields", "id", { status: 404 })).toEqual({
      outcome: "failed",
      referenceStatus: 404,
      reasons: ["not-found"],
    });
  });

  it.each([401, 429, 500, 503])(
    "does not accept status%s as permission qualification",
    (status) => {
      expect(() => restrictedReadExpectation("jira.projects", "key", { status })).toThrow();
    },
  );

  it("requires the independently visible isolated project and excludes cross-project reads", () => {
    expect(
      restrictedReadExpectation("jira.projects", "key", {
        status: 200,
        value: [{ key: "ISOLATED" }],
      }).readExpected.values,
    ).toEqual(["ISOLATED"]);
    expect(() =>
      restrictedReadExpectation("jira.projects", "key", { status: 200, value: [{ key: "KEIKO" }] }),
    ).toThrow();
    expect(() =>
      restrictedReadExpectation("jira.search", "key", {
        status: 200,
        value: { issues: [{ key: "KEIKO-1" }] },
      }),
    ).toThrow();
  });

  it("covers every mutation with the restricted identity and a valid exact fixture target", () => {
    const writes = restrictedWriteCases(fixture, "10001", transition, "catalog");
    expect(new Set(writes.map((item) => item.operation))).toEqual(
      new Set(["jira.create", "jira.edit", "jira.assign", "jira.comment", "jira.transition"]),
    );
    for (const item of writes) {
      expect(item.actor).toBe("restricted");
      expect(item.localRefusalAllowed).toBe(true);
      expect(item.dispatches).toBe(1);
      expect(item.outcome).toBe("unknown");
    }
    expect(writes[0].target.body.fields.project.id).toBe("10001");
    expect(writes[0].arguments.fields[fixture.requiredFieldId]).toBeDefined();
  });

  it("requires known local rejection only when no mutation was attempted", () => {
    const candidate = restrictedWriteCases(fixture, "10001", transition, "catalog")[0];
    const local = restrictedCaseAtDispatch(candidate, { attempts: 0, forwarded: 0, status: 0 });
    expect(local.outcome).toBe("rejected");
    expect(local.dispatches).toBe(0);
    const remote = restrictedCaseAtDispatch(candidate, { attempts: 1, forwarded: 1, status: 403 });
    expect(remote.outcome).toBe("unknown");
    expect(remote.dispatches).toBe(1);
    expect(() =>
      restrictedCaseAtDispatch(candidate, { attempts: 2, forwarded: 1, status: 403 }),
    ).toThrow();
    expect(() =>
      restrictedCaseAtDispatch(candidate, { attempts: 2, forwarded: 2, status: 403 }),
    ).toThrow();
  });
});
