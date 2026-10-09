import { describe, expect, it } from "vitest";
import { classifyRetrievalIntent } from "./intent.js";

describe("manifest inventory uses canonical project metadata admission", () => {
  it.each([
    "Which package manifests define this workspace?",
    "Which project manifest defines this workspace?",
    "List workspace manifests.",
  ])("recognizes the inventory query %s", (text) => {
    expect(classifyRetrievalIntent(text).intent).toBe("project-metadata");
  });

  it.each([
    "Read docs/manual.html and explain the package manifests it documents.",
    "How does ManifestReader parse package manifests?",
    "Explain the manifest format in the HTML handbook.",
    "Explain src/manifest.ts and its workspace manifests.",
  ])("retains source-focused intent for %s", (text) => {
    expect(classifyRetrievalIntent(text).intent).toBe("targeted-code-search");
  });

  it("preserves diagnostic priority for manifest discovery failures", () => {
    expect(classifyRetrievalIntent("Why does discovering package manifests fail?").intent).toBe(
      "diagnostic-search",
    );
  });
});
