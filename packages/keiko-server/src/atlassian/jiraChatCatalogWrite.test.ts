import { describe, expect, it } from "vitest";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security/hashing";
import type { CatalogBoundHandler } from "../tool-catalog/catalogToolPorts.js";
import { jiraOperationForTool } from "./jiraManagedProvider.js";
import { jiraChatWriteAction, withApprovalNames } from "./jiraChatCatalogWrite.js";
import {
  jiraChatCatalogConsumerPort,
  jiraChatCatalogRoutes,
  type JiraChatCatalogConsumer,
  type JiraChatCatalogAction,
} from "./jiraChatCatalogConsumer.js";
import type { JiraOperationContract } from "./jiraOperationRegistry.js";

function fixture(): {
  readonly action: JiraChatCatalogAction;
  readonly handler: CatalogBoundHandler<JiraChatCatalogConsumer>;
  readonly contract: JiraOperationContract;
} {
  const contract = jiraOperationForTool("jira.comment");
  const route = jiraChatCatalogRoutes(["jira.comment"])[0];
  if (contract === undefined || route === undefined)
    throw new TypeError("Missing comment contract");
  const action = route.actionFor(
    { issueKey: "SYN-1", body: "Approved" },
    {
      actionId: "synthetic-action",
      idempotencyKey: "synthetic-key",
    },
  );
  const descriptor = contract.declaration.descriptor;
  const handler: CatalogBoundHandler<JiraChatCatalogConsumer> = {
    descriptor,
    binding: {
      toolRef: descriptor.toolRef,
      descriptorDigest: descriptor.descriptorDigest,
      handlerId: descriptor.handlerRequirement.id,
      handlerVersion: descriptor.handlerRequirement.contractVersion,
      catalogAction: "jira.comment",
      readiness: () => "ready",
      previewAction: route.previewAction,
      actionFor: route.actionFor,
      execute: () =>
        Promise.resolve({
          data: {},
          page: { truncated: false, reason: "none", cursor: null },
          resultCount: 0,
        }),
    },
  };
  return { action, handler, contract };
}

describe("Jira catalog approval contract binding", () => {
  it("binds current operation semantics into approval and durable action identity", () => {
    const { action, contract } = fixture();
    const identity = jiraChatWriteAction(action);
    expect(identity?.actionDigest).toBe(
      sha256Hex(
        canonicalise({
          operation: action.tool,
          argumentsDigest: action.argumentsDigest,
          operationBinding: contract.binding,
        }),
      ),
    );
    expect(identity?.actionDigest).not.toBe(
      sha256Hex(
        canonicalise({
          operation: action.tool,
          argumentsDigest: action.argumentsDigest,
        }),
      ),
    );
    // Names read for the card (F09) are added after the identity exists and never enter it.
    expect(identity).not.toHaveProperty("projects");
    expect(identity).not.toHaveProperty("transition");
    expect(identity).not.toHaveProperty("fields");
    expect(Object.keys(identity ?? {}).sort()).toEqual([
      "actionDigest",
      "invocationId",
      "operation",
    ]);
    expect(jiraChatCatalogConsumerPort.captureApprovedAction({ ...action })).toEqual(action);
  });

  it("refuses missing, stale, foreign and extended bindings before approval or dispatch", () => {
    const { action, handler, contract } = fixture();
    const { operationBinding: _binding, ...legacy } = action;
    const substituted = [
      legacy,
      { ...action, operationBinding: { ...contract.binding, contractDigest: "0".repeat(64) } },
      { ...action, operationBinding: { ...contract.binding, identity: "POST /rest/api/2/issue" } },
      { ...action, operationBinding: { ...contract.binding, approval: "granted" } },
    ];
    for (const candidate of substituted) {
      expect(jiraChatWriteAction(candidate)).toBeUndefined();
      expect(jiraChatCatalogConsumerPort.captureApprovedAction({ ...candidate })).toBeUndefined();
      expect(
        jiraChatCatalogConsumerPort.captureAction(handler, { ...candidate }, undefined, undefined),
      ).toBeUndefined();
    }
  });

  it("refuses a descriptor from another contract even with a valid operation binding", () => {
    const { action, handler } = fixture();
    expect(
      jiraChatCatalogConsumerPort.captureAction(handler, { ...action }, undefined, undefined),
    ).toEqual(action);
    const other = jiraOperationForTool("jira.create");
    if (other === undefined) throw new TypeError("Missing create contract");
    expect(
      jiraChatCatalogConsumerPort.captureAction(
        { ...handler, descriptor: other.declaration.descriptor },
        { ...action },
        undefined,
        undefined,
      ),
    ).toBeUndefined();
  });

  it.each(["jira.discover", "jira.describe"] as const)(
    "does not fabricate remote authority for %s",
    (name) => {
      const route = jiraChatCatalogRoutes([name])[0];
      if (route === undefined) throw new TypeError("Missing discovery route");
      const action = route.actionFor({}, { actionId: "local", idempotencyKey: "local" });
      expect(action.operationBinding).toBeUndefined();
      expect(jiraChatCatalogConsumerPort.captureApprovedAction({ ...action })).toEqual(action);
      expect(jiraChatWriteAction(action)).toBeUndefined();
    },
  );
});

// R04: the project, transition and field names of one card are read together, so a slow Jira holds
// the card for one window and never for the sum of its reads.
describe("the names an approval card carries are read together", () => {
  const slow = <T>(value: T, ms: number): Promise<T> =>
    new Promise((resolve) => {
      setTimeout(() => {
        resolve(value);
      }, ms);
    });
  it("adds each name to the identity without waiting for one read after another", async () => {
    const { action } = fixture();
    const identity = jiraChatWriteAction(action);
    if (identity === undefined) throw new TypeError("Missing identity");
    const options = {
      projectPreview: () => slow([{ ref: "10000", key: "SYN" }], 300),
      transitionPreview: () => slow({ ref: "11", targetStatusName: "In Arbeit" }, 300),
      fieldNamesPreview: () => slow([{ id: "customfield_1", name: "Punkte" }], 300),
    } as unknown as Parameters<typeof withApprovalNames>[0];
    const started = Date.now();
    const named = await withApprovalNames(options, action, identity);
    expect(Date.now() - started).toBeLessThan(700);
    expect(named).toMatchObject({
      actionDigest: identity.actionDigest,
      projects: [{ ref: "10000", key: "SYN" }],
      transition: { ref: "11", targetStatusName: "In Arbeit" },
      fields: [{ id: "customfield_1", name: "Punkte" }],
    });
  });
  it("adds nothing for a read that names nothing", async () => {
    const { action } = fixture();
    const identity = jiraChatWriteAction(action);
    if (identity === undefined) throw new TypeError("Missing identity");
    const named = await withApprovalNames(
      {} as Parameters<typeof withApprovalNames>[0],
      action,
      identity,
    );
    expect(named).toEqual(identity);
  });
});
