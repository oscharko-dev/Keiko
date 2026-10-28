import { describe, expect, it } from "vitest";
import { validateToolArguments } from "./arguments.js";
import { createToolDescriptor } from "./descriptor.js";
import { ToolCatalogError } from "./errors.js";
import { declaration, fixture } from "./__fixtures__/catalog.js";
import { createKeikoToolCatalog } from "./composer.js";
import { lookupCatalogTool } from "./catalog.js";
import { opencodeRegistrationSet } from "./opencode.js";
import { createToolRef } from "./identity.js";
import {
  CHANGESET_EDIT_ARGUMENT_LIMITS,
  TOOL_CATALOG_LIMITS,
  type CatalogJsonValue,
  type ToolDescriptor,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";

describe("catalog invocation argument qualification", () => {
  it("returns a detached frozen value under the actual descriptor schema", () => {
    const { descriptor } = fixture();
    const input = { path: "file.ts" };
    const result = validateToolArguments(input, descriptor);
    expect(result).toEqual(input);
    expect(result).not.toBe(input);
    expect(Object.isFrozen(result)).toBe(true);
    input.path = "later.ts";
    expect(result).toEqual({ path: "file.ts" });
  });
  it.each([null, {}, { path: "" }, { path: 1 }, { path: "file.ts", root: "/private" }])(
    "rejects values outside the descriptor schema",
    (input) => {
      expect(() => validateToolArguments(input, fixture().descriptor)).toThrow("invalid-shape");
    },
  );
  // Run 7 of the Workbench engagement (2026-09-10): three identical `invalid-shape` rejections of
  // one call exhausted the gateway's retry budget, and neither the log nor the model's correction
  // could say which declared property was missing. The rejection now carries the schema's own account
  // -- declared property paths and a count -- and never the arguments.
  it.each([
    [
      {},
      {
        missingRequired: ["path"],
        invalidPaths: [],
        unexpectedPropertyCount: 0,
        droppedPathCount: 0,
      },
    ],
    [
      { path: 1 },
      {
        missingRequired: [],
        invalidPaths: ["path"],
        unexpectedPropertyCount: 0,
        droppedPathCount: 0,
      },
    ],
    [
      { path: "" },
      {
        missingRequired: [],
        invalidPaths: ["path"],
        unexpectedPropertyCount: 0,
        droppedPathCount: 0,
      },
    ],
    [
      { path: "file.ts", root: "/private" },
      { missingRequired: [], invalidPaths: [], unexpectedPropertyCount: 1, droppedPathCount: 0 },
    ],
  ] as const)(
    "names the schema mismatch on the rejection without quoting the value",
    (input, shape) => {
      const failure = ((): unknown => {
        try {
          validateToolArguments(input, fixture().descriptor);
          return undefined;
        } catch (error) {
          return error;
        }
      })();
      expect(failure).toBeInstanceOf(ToolCatalogError);
      expect(failure).toMatchObject({ reason: "invalid-shape", shape });
      expect(JSON.stringify((failure as ToolCatalogError).shape)).not.toContain("/private");
      expect(JSON.stringify((failure as ToolCatalogError).shape)).not.toContain("root");
    },
  );
  // PR #3452 review (CodeRabbit): every case above leaves `droppedPathCount` at 0, so the cap itself
  // was unpinned. A schema with more mismatching properties than the report cap must keep BOTH lists
  // bounded, count exactly what it left out, and still quote no argument value.
  it("bounds both mismatch lists at the cap and counts the paths it left out", () => {
    const width = 40;
    const properties = Object.fromEntries(
      Array.from({ length: width }, (_, index) => [
        `p${String(index).padStart(2, "0")}`,
        { type: "string", minLength: 1, maxLength: 8 },
      ]),
    );
    const descriptor = createToolDescriptor({
      ...declaration(),
      inputSchema: {
        type: "object",
        properties,
        required: Object.keys(properties),
        additionalProperties: false,
      },
    });
    const secret = "SENTINEL_VALUE";
    // Half the declared properties are present but too long (invalid paths); half are absent
    // (missing required). Both lists overflow the cap of 16 by four entries each.
    const input = Object.fromEntries(
      Array.from({ length: width / 2 }, (_, index) => [
        `p${String(index).padStart(2, "0")}`,
        secret,
      ]),
    );

    const failure = ((): unknown => {
      try {
        validateToolArguments(input, descriptor);
        return undefined;
      } catch (error) {
        return error;
      }
    })();

    expect(failure).toBeInstanceOf(ToolCatalogError);
    const shape = (failure as ToolCatalogError).shape;
    expect(shape?.invalidPaths).toHaveLength(16);
    expect(shape?.missingRequired).toHaveLength(16);
    expect(shape?.droppedPathCount).toBe(width - 32);
    expect(shape?.unexpectedPropertyCount).toBe(0);
    expect(JSON.stringify(shape)).not.toContain(secret);
  });

  it("rejects untrusted descriptor identity and byte-bound violations", () => {
    const { descriptor } = fixture();
    expect(() =>
      validateToolArguments({ path: "file.ts" }, { ...descriptor, description: "tampered" }),
    ).toThrow();
    const bounded = createToolDescriptor({
      ...declaration(),
      bounds: { ...descriptor.bounds, maxArgumentBytes: 16 },
    });
    expect(() => validateToolArguments({ path: "bounded-file.ts" }, bounded)).toThrow(
      "input-bound",
    );
  });
  it("rejects getters and non-JSON data without executing them", () => {
    let reads = 0;
    const input = Object.defineProperty({}, "path", {
      enumerable: true,
      get: () => {
        reads += 1;
        return "file.ts";
      },
    });
    expect(() => validateToolArguments(input, fixture().descriptor)).toThrow();
    expect(reads).toBe(0);
    expect(() =>
      validateToolArguments({ path: "file.ts", hidden: undefined }, fixture().descriptor),
    ).toThrow();
  });
});

// Owner decision 2026-10-28: the mapped profile's changeset edit carries file content up to the
// changeset cap in one string; every other tool keeps the generic 64 KiB string.
describe("changeset edit argument ceilings", () => {
  const catalog = createKeikoToolCatalog([opencodeRegistrationSet()]);
  function descriptorOf(canonicalId: string): ToolDescriptor {
    const descriptor = lookupCatalogTool(catalog, createToolRef(canonicalId, 1));
    if (descriptor === undefined) throw new Error(`missing ${canonicalId}`);
    return descriptor;
  }
  function editArguments(oldString: string, newString: string): CatalogJsonValue {
    return {
      changeset: {
        edits: [{ file: "src/a.ts", oldString, newString, replaceAll: false }],
        deletions: [],
        renames: [],
        files: [{ file: "src/a.ts", expectedContentHash: "a".repeat(64) }],
        selectedFiles: ["src/a.ts"],
      },
    };
  }

  it("declares the changeset ceilings on the descriptor, and only there", () => {
    const edit = descriptorOf("keiko.changeset.edit");
    expect(edit.bounds.maxArgumentBytes).toBe(CHANGESET_EDIT_ARGUMENT_LIMITS.maxArgumentBytes);
    expect(descriptorOf("keiko.workspace.read").bounds.maxArgumentBytes).toBe(
      TOOL_CATALOG_LIMITS.maxArgumentBytes,
    );
    expect(edit.bounds.maxResultBytes).toBe(TOOL_CATALOG_LIMITS.maxResultBytes);
  });

  it("admits a replacement far above 64 KiB and 256 KiB, up to the changeset cap", () => {
    const edit = descriptorOf("keiko.changeset.edit");
    const big = "y".repeat(TOOL_CATALOG_LIMITS.maxArgumentBytes + 1);
    expect(validateToolArguments(editArguments("", big), edit)).toEqual(editArguments("", big));
    const cap = "z".repeat(CHANGESET_EDIT_ARGUMENT_LIMITS.maxStringBytes);
    expect(validateToolArguments(editArguments("", cap), edit)).toEqual(editArguments("", cap));
  });

  it("refuses a string over the cap and a call over the argument ceiling", () => {
    const edit = descriptorOf("keiko.changeset.edit");
    const over = "z".repeat(CHANGESET_EDIT_ARGUMENT_LIMITS.maxStringBytes + 1);
    expect(() => validateToolArguments(editArguments("", over), edit)).toThrow("input-bound");
    const cap = "z".repeat(CHANGESET_EDIT_ARGUMENT_LIMITS.maxStringBytes);
    const edits = Array.from({ length: 4 }, () => ({
      file: "src/a.ts",
      oldString: cap,
      newString: cap,
      replaceAll: false,
    }));
    expect(() =>
      validateToolArguments(
        { changeset: { ...(editArguments("", "") as { changeset: object }).changeset, edits } },
        edit,
      ),
    ).toThrow("input-bound");
  });

  it("keeps the generic 64 KiB string for every other tool", () => {
    const read = descriptorOf("keiko.workspace.read");
    expect(() =>
      validateToolArguments(
        {
          relativePath: "x".repeat(TOOL_CATALOG_LIMITS.maxStringBytes + 1),
          startLine: 1,
          maxLines: 1,
        },
        read,
      ),
    ).toThrow();
  });
});
