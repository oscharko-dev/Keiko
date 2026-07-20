import { describe, expect, it } from "vitest";

import { localKnowledgeVectorIndexOptions } from "./local-knowledge-store-open.js";

describe("localKnowledgeVectorIndexOptions", () => {
  it("keeps unset and invalid modes disabled", () => {
    const unset = localKnowledgeVectorIndexOptions({ env: {} });
    const invalid = localKnowledgeVectorIndexOptions({
      env: { KEIKO_LOCAL_KNOWLEDGE_VECTOR_INDEX: "enabled" },
    });

    expect(unset.mode).toBe("disabled");
    expect(unset.sqliteVec).toBeUndefined();
    expect(invalid.mode).toBe("disabled");
    expect(invalid.sqliteVec).toBeUndefined();
  });

  // There is no bundled runtime to map to: sqlite-vec is not an npm dependency, because its
  // published SPDX string is invalid and the repository's supply-chain policy rejects it. An active
  // mode alone therefore resolves to no module, and the store keeps extension loading disabled —
  // activation needs an operator-provisioned extension path (ADR-0152 D2).
  it("maps auto mode without selecting any runtime, so activation stays explicit", () => {
    const resolved = localKnowledgeVectorIndexOptions({
      env: { KEIKO_LOCAL_KNOWLEDGE_VECTOR_INDEX: "auto" },
    });

    expect(resolved.mode).toBe("auto");
    expect(resolved.sqliteVec).toBeUndefined();
    expect(resolved.sqliteVecExtensionPath).toBeUndefined();
  });

  it("carries an explicit operator-provisioned extension path through", () => {
    const resolved = localKnowledgeVectorIndexOptions({
      env: {
        KEIKO_LOCAL_KNOWLEDGE_VECTOR_INDEX: "sqlite-vec",
        KEIKO_LOCAL_KNOWLEDGE_SQLITE_VEC_EXTENSION_PATH: "/opt/keiko/vec0",
      },
    });

    expect(resolved).toMatchObject({
      mode: "sqlite-vec",
      sqliteVecExtensionPath: "/opt/keiko/vec0",
    });
    expect(resolved.sqliteVec).toBeUndefined();
  });
});
