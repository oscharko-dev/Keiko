import { describe, expect, it } from "vitest";
import { registerKeikoImplementationProvider } from "./implementation-bridge.js";
import type { EditorDefinitionResolver } from "../types.js";

describe("registerKeikoImplementationProvider", () => {
  it("registers Monaco implementation providers only for configured languages", () => {
    const registered: string[] = [];
    const resolve: EditorDefinitionResolver = (query) =>
      Promise.resolve({ request: query.request.request, locations: [] });
    registerKeikoImplementationProvider({
      languages: {
        registerImplementationProvider: (language) => {
          registered.push(String(language));
          return { dispose: (): void => undefined };
        },
      },
      resolve,
      isCurrentDocument: () => true,
      documentLanguages: ["typescript"],
      streamId: "implementation",
      newRequestId: () => "request",
    });

    expect(registered).toEqual(["typescript"]);
  });
});
