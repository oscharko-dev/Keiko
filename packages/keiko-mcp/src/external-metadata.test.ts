import { expect, it, vi } from "vitest";
import type { Transport } from "@modelcontextprotocol/client";
import { admitExternalToolList, installExternalMetadataAdmission } from "./external-metadata.js";

function listing(
  inputSchema: unknown,
  name = "synthetic",
): { tools: { name: string; inputSchema: unknown }[] } {
  return { tools: [{ name, inputSchema }] };
}
const empty = { type: "object", properties: {}, additionalProperties: false };
it("preserves valid header metadata exactly, including nested primitive properties", () => {
  const schema = {
    type: "object",
    properties: {
      scope: {
        type: "object",
        properties: { project: { type: "string", "x-mcp-header": "Project" } },
      },
      revision: { type: "integer", "x-mcp-header": "Revision" },
      enabled: { type: "boolean", "x-mcp-header": "Enabled" },
    },
    additionalProperties: false,
  };
  const input = listing(schema);
  const before = JSON.stringify(input);
  expect(admitExternalToolList(input)).toEqual(["synthetic"]);
  expect(JSON.stringify(input)).toBe(before);
});
it.each([
  { type: "string", "x-mcp-header": "" },
  { type: "string", "x-mcp-header": "private header" },
  { type: "string", "x-mcp-header": "\r\nprivate" },
  { type: "string", "x-mcp-header": 42 },
  { type: "number", "x-mcp-header": "Header" },
  { type: ["string"], "x-mcp-header": "Header" },
  { type: "object", "x-mcp-header": "Header" },
])("rejects malformed primitive header declarations without rewriting them", (property) => {
  expect(
    admitExternalToolList(listing({ type: "object", properties: { value: property } })),
  ).toBeUndefined();
});
it.each(["items", "additionalProperties", "not", "if", "contentSchema"])(
  "rejects an unreachable header under %s",
  (keyword) => {
    expect(
      admitExternalToolList(
        listing({
          type: "object",
          [keyword]: {
            type: "object",
            properties: { hidden: { type: "string", "x-mcp-header": "Hidden" } },
          },
        }),
      ),
    ).toBeUndefined();
  },
);
it("rejects duplicate case-insensitive headers, root annotations and headers under alternatives", () => {
  const property = { type: "string", "x-mcp-header": "Header" };
  expect(
    admitExternalToolList(listing({ type: "object", "x-mcp-header": "Root" })),
  ).toBeUndefined();
  expect(
    admitExternalToolList(
      listing({
        type: "object",
        properties: {
          a: property,
          b: { ...property, "x-mcp-header": "hEaDeR" },
        },
      }),
    ),
  ).toBeUndefined();
  expect(
    admitExternalToolList(listing({ type: "object", anyOf: [{ properties: { a: property } }] })),
  ).toBeUndefined();
});
it("bounds deep schemas, total metadata, cycles and non-JSON values before SDK processing", () => {
  let deep: unknown = { type: "string" };
  for (let index = 0; index < 40; index++) deep = { type: "object", properties: { child: deep } };
  expect(admitExternalToolList(listing(deep))).toBeUndefined();
  expect(
    admitExternalToolList({ ...listing(empty), private: "x".repeat(1024 * 1024) }),
  ).toBeUndefined();
  const cyclic: Record<string, unknown> = listing(empty);
  cyclic.self = cyclic;
  expect(admitExternalToolList(cyclic)).toBeUndefined();
  expect(admitExternalToolList({ ...listing(empty), private: () => undefined })).toBeUndefined();
  const getter = vi.fn(() => []);
  expect(
    admitExternalToolList(Object.defineProperty({}, "tools", { get: getter })),
  ).toBeUndefined();
  expect(getter).not.toHaveBeenCalled();
  const serializer = vi.fn(() => ({}));
  expect(
    admitExternalToolList(Object.assign(Object.create({ toJSON: serializer }), listing(empty))),
  ).toBeUndefined();
  expect(serializer).not.toHaveBeenCalled();
});
it("admits only matching list replies and bounds names across paginated discovery", async () => {
  const transport: Transport = {
    start: () => Promise.resolve(),
    close: () => Promise.resolve(),
    send: () => Promise.resolve(),
  };
  const reject = vi.fn();
  installExternalMetadataAdmission(transport, reject);
  await transport.send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  transport.onmessage?.({ jsonrpc: "2.0", id: 99, result: { tools: "ignored unrelated payload" } });
  transport.onmessage?.({
    jsonrpc: "2.0",
    id: 1,
    result: { ...listing(empty), nextCursor: "next" },
  });
  await transport.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: { cursor: "next" } });
  expect(() => transport.onmessage?.({ jsonrpc: "2.0", id: 2, result: listing(empty) })).toThrow(
    "Managed MCP operation failed",
  );
  expect(reject).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ reason: "protocol-error" }),
  );
  expect(() => transport.onmessage?.({ jsonrpc: "2.0", id: 99, result: {} })).toThrow(
    "Managed MCP operation failed",
  );
});
