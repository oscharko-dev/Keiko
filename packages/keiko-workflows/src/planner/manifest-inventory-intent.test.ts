import { describe, expect, it } from "vitest";
import { classifyRetrievalIntent } from "./intent.js";

describe("manifest inventory uses canonical project metadata admission", () => {
  it.each([
    "Which package manifests define this workspace?",
    "Which project manifest defines this workspace?",
    "List workspace manifests.",
    "Enumerate all project manifests.",
    "Welche Paketmanifeste definieren dieses Projekt?",
    "Liste alle Workspace-Manifeste.",
  ])("recognizes the inventory query %s", (text) => {
    expect(classifyRetrievalIntent(text).intent).toBe("project-metadata");
  });

  it.each([
    "Read docs/manual.html and explain the package manifests it documents.",
    "How does ManifestReader parse package manifests?",
    "Explain the manifest format in the HTML handbook.",
    "Explain src/manifest.ts and its workspace manifests.",
    "How are package manifests validated before loading, and what is the maximum number of permissions?",
    "Explain how project manifests are loaded.",
    "Which package manifests are validated before loading?",
    "List workspace manifests and explain how loading validates them.",
    "Wie werden Paketmanifeste vor dem Laden validiert und welche Berechtigungen sind erlaubt?",
    "Erkläre das Laden von Workspace-Manifesten.",
  ])("retains source-focused intent for %s", (text) => {
    expect(classifyRetrievalIntent(text).intent).toBe("targeted-code-search");
  });

  it("preserves diagnostic priority for manifest discovery failures", () => {
    expect(classifyRetrievalIntent("Why does discovering package manifests fail?").intent).toBe(
      "diagnostic-search",
    );
  });
});
