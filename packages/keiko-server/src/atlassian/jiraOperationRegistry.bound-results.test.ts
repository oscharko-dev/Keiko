import { expect, it } from "vitest";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { describeCatalogSchemaMismatch } from "@oscharko-dev/keiko-tool-catalog";
import { jiraOperationForTool } from "./jiraManagedProvider.js";
import {
  createJiraOperationContract,
  historicalResultDescriptor,
} from "./jiraOperationRegistry.js";

function resultUnionContract(
  schema: CatalogJsonObject,
): ReturnType<typeof createJiraOperationContract> {
  const original = jiraOperationForTool("jira.application-properties")?.declaration;
  if (original === undefined) throw new TypeError("Missing application-properties contract");
  const dialect = original.descriptor.resultSchema.$schema;
  if (typeof dialect !== "string") throw new TypeError("Missing native schema dialect");
  return createJiraOperationContract({
    ...original,
    descriptor: { ...original.descriptor, resultSchema: { $schema: dialect, ...schema } },
  });
}
const CLOSED_RESULT_BRANCH = {
  type: "object",
  properties: { outcome: { type: "string", enum: ["succeeded"] } },
  required: ["outcome"],
  additionalProperties: false,
} as const;
it.each(["anyOf", "oneOf"])(
  "binds an explicit object %s without opening its branches",
  (keyword) => {
    const contract = resultUnionContract({ type: "object", [keyword]: [CLOSED_RESULT_BRANCH] });
    const schema = contract.declaration.descriptor.resultSchema;
    expect(schema.type).toBe("object");
    const value = { outcome: "succeeded", operationBinding: contract.binding };
    expect(describeCatalogSchemaMismatch(schema, value)).toBeUndefined();
    expect(describeCatalogSchemaMismatch(schema, { outcome: "succeeded" })).toBeDefined();
    expect(describeCatalogSchemaMismatch(schema, { ...value, extra: true })).toBeDefined();
  },
);
it.each(["array", "boolean", "integer", "null", "number", "string"])(
  "refuses a %s result disjunction at the binding boundary",
  (type) => {
    expect(() => resultUnionContract({ type, anyOf: [CLOSED_RESULT_BRANCH] })).toThrow(
      "invalid-schema",
    );
  },
);
it.each(["anyOf", "oneOf"])(
  "qualifies a result stored before the binding against the unbound %s descriptor only",
  (keyword) => {
    const contract = resultUnionContract({ type: "object", [keyword]: [CLOSED_RESULT_BRANCH] });
    const bound = contract.declaration.descriptor;
    const historical = historicalResultDescriptor(bound);
    const value = { outcome: "succeeded" };
    expect(describeCatalogSchemaMismatch(bound.resultSchema, value)).toBeDefined();
    expect(describeCatalogSchemaMismatch(historical.resultSchema, value)).toBeUndefined();
    expect(
      describeCatalogSchemaMismatch(historical.resultSchema, { ...value, extra: true }),
    ).toBeDefined();
    expect(historical.toolRef).toEqual(bound.toolRef);
    expect(historicalResultDescriptor(historical)).toBe(historical);
  },
);
