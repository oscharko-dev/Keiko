import { describe, expect, it, vi } from "vitest";
import { registerKeikoTypeDefinitionProvider } from "./type-definition-bridge.js";
import type { EditorDefinitionResolver } from "../types.js";

describe("registerKeikoTypeDefinitionProvider", () => {
  it("registers Monaco type-definition providers for governed languages", () => {
    const registered: string[] = [];
    const resolve: EditorDefinitionResolver = (query) =>
      Promise.resolve({ request: query.request.request, locations: [] });
    const dispose = vi.fn();
    const result = registerKeikoTypeDefinitionProvider({
      languages: {
        registerTypeDefinitionProvider: (language) => {
          registered.push(String(language));
          return { dispose };
        },
      },
      resolve,
      isCurrentDocument: () => true,
      documentLanguages: ["typescript", "javascript"],
      streamId: "type-definition",
      newRequestId: () => "request",
    });

    expect(registered).toEqual(["typescript", "javascript"]);
    result.dispose();
    expect(dispose).toHaveBeenCalledTimes(2);
  });
});
