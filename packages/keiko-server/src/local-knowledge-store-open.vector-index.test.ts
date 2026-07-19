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

  it("maps auto mode to the bundled sqlite-vec runtime", () => {
    const resolved = localKnowledgeVectorIndexOptions({
      env: { KEIKO_LOCAL_KNOWLEDGE_VECTOR_INDEX: "auto" },
    });

    expect(resolved.mode).toBe("auto");
    expect(resolved.sqliteVec?.load).toBeTypeOf("function");
    expect(resolved.sqliteVecExtensionPath).toBeUndefined();
  });

  it("maps an explicit extension path without also selecting the bundled loader", () => {
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
