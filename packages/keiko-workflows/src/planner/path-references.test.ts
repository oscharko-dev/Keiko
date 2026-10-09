import { describe, expect, it } from "vitest";
import { extractPathReferences, extractRetrievalChannels } from "./references.js";

describe("literal bracket path references precede anchor fragmentation", () => {
  it.each([
    "app/z-users/[id]/page.tsx",
    "app/z-users/[...slug]/page.tsx",
    "app/z-users/[[...slug]]/page.tsx",
    "app/(auth)/z-users/[id]/page.tsx",
    "app/z-users/[customer-id]/page.tsx",
  ])("preserves the complete unquoted file path %s", (path) => {
    expect(extractPathReferences(`Explain ${path}`)).toEqual([{ path, origin: "query" }]);
  });

  it.each([".", ":17", ":17:3", ":17:3."])(
    "retains physical line hints and sentence punctuation: %s",
    (suffix) => {
      const path = "app/z-users/[id]/page.tsx";
      expect(extractPathReferences(`Explain ${path}${suffix}`)).toEqual([
        { path, origin: "query", ...(suffix.startsWith(":") ? { line: 17 } : {}) },
      ]);
    },
  );

  it("keeps the identical backticked path and ordinary directory controls", () => {
    const path = "app/z-users/[id]/page.tsx";
    expect(extractPathReferences(`Explain \`${path}\``)).toEqual([{ path, origin: "query" }]);
    expect(extractPathReferences("Explain app/z-users/42/page.tsx")).toEqual([
      { path: "app/z-users/42/page.tsx", origin: "query" },
    ]);
  });

  it("does not leave bracket segment words in the independent user-term channel", () => {
    const result = extractRetrievalChannels(
      "Explain InvoiceValidator app/z-users/[id]/page.tsx",
      8,
    );
    expect(result.references).toEqual([{ path: "app/z-users/[id]/page.tsx", origin: "query" }]);
    expect(result.anchors.map((anchor) => anchor.term)).toEqual(["invoicevalidator"]);
  });

  it("keeps separate explicit fragment references in their original occurrence order", () => {
    expect(
      extractPathReferences("Explain app/z-users/[id]/page.tsx and /page.tsx and src/Other.ts"),
    ).toEqual([
      { path: "app/z-users/[id]/page.tsx", origin: "query" },
      { path: "/page.tsx", origin: "query" },
      { path: "src/Other.ts", origin: "query" },
    ]);
  });

  it("preserves the existing six-reference bound", () => {
    const paths = Array.from({ length: 8 }, (_, index) => `app/[id${String(index)}]/page.tsx`);
    expect(extractRetrievalChannels(paths.join(" "), 8).references).toEqual(
      paths.slice(0, 6).map((path) => ({ path, origin: "query" })),
    );
  });

  it("retains unsafe paths for the existing closed admission policy", () => {
    const paths = ["../app/[id]/page.tsx", "/outside/[id]/page.tsx", "dist/[id]/page.tsx"];
    expect(extractPathReferences(paths.join(" "))).toEqual(
      paths.map((path) => ({ path, origin: "query" })),
    );
  });

  it("keeps the existing anchor producer's metadata limit", () => {
    const path = `app/${"folder/".repeat(700)}[id]/page.tsx`;
    expect(extractPathReferences(`Explain ${path}`)).not.toContainEqual({ path, origin: "query" });
  });
});
