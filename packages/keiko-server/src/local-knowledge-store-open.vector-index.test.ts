import { describe, expect, it } from "vitest";

import { localKnowledgeVectorIndexOptions } from "./local-knowledge-store-open.js";

describe("localKnowledgeVectorIndexOptions", () => {
  // Issue #2631: production deps.env carries no `KEIKO_LOCAL_KNOWLEDGE_VECTOR_INDEX` in the shipped
  // configuration, so the default the funnel returns for every server handler is what the product
  // actually runs on. It must resolve to auto (default-on by capability); the runtime bytes then gate
  // ACTIVATION downstream at `openKnowledgeStore` (ADR-0152 D2).
  it("resolves the shipped funnel to auto without any env config", () => {
    const shipped = localKnowledgeVectorIndexOptions({ env: {} });

    expect(shipped.mode).toBe("auto");
    expect(shipped.usearchBinaryPath).toBeUndefined();
  });

  // An unrecognised value is treated as unset — the same default-on outcome — rather than a silent
  // opt-out. The operator override is a single explicit value: "disabled".
  it("falls through unrecognised values to the auto default", () => {
    const invalid = localKnowledgeVectorIndexOptions({
      env: { KEIKO_LOCAL_KNOWLEDGE_VECTOR_INDEX: "enabled" },
    });

    expect(invalid.mode).toBe("auto");
    expect(invalid.usearchBinaryPath).toBeUndefined();
  });

  it("honours an explicit disabled override", () => {
    const disabled = localKnowledgeVectorIndexOptions({
      env: { KEIKO_LOCAL_KNOWLEDGE_VECTOR_INDEX: "disabled" },
    });

    expect(disabled.mode).toBe("disabled");
    expect(disabled.usearchBinaryPath).toBeUndefined();
  });

  // Explicit auto remains a valid operator choice without granting a runtime path.
  it("maps explicit auto without selecting any runtime, so activation stays explicit", () => {
    const resolved = localKnowledgeVectorIndexOptions({
      env: { KEIKO_LOCAL_KNOWLEDGE_VECTOR_INDEX: "auto" },
    });

    expect(resolved.mode).toBe("auto");
    expect(resolved.usearchBinaryPath).toBeUndefined();
  });

  it("carries an explicit verified native-runtime path through", () => {
    const resolved = localKnowledgeVectorIndexOptions({
      env: {
        KEIKO_LOCAL_KNOWLEDGE_VECTOR_INDEX: "usearch",
        KEIKO_USEARCH_BINARY_PATH: "/opt/keiko/usearch.node",
      },
    });

    expect(resolved).toMatchObject({
      mode: "usearch",
      usearchBinaryPath: "/opt/keiko/usearch.node",
    });
  });
});
