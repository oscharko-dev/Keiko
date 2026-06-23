import { describe, expect, it } from "vitest";

import { classifyRetrievalIntent } from "./intent.js";

describe("classifyRetrievalIntent", () => {
  it.each([
    "Welche Type-Script Version wird in der App verwendet?",
    "Welche Node-Version erwartet das Projekt?",
    "Welcher Test-Runner wird in der UI verwendet?",
    "Which package manager does this repository use?",
  ])("classifies project metadata query: %s", (text) => {
    expect(classifyRetrievalIntent(text).intent).toBe("project-metadata");
  });

  it.each([
    "Erkläre grob die Architektur dieses Repositories.",
    "Give me an overview of this codebase structure.",
  ])("classifies repository overview query: %s", (text) => {
    expect(classifyRetrievalIntent(text).intent).toBe("repository-overview");
  });

  it("classifies stacktrace and HTTP failures as diagnostic search", () => {
    expect(classifyRetrievalIntent("Warum bekomme ich HTTP 503 im Chat?").intent).toBe(
      "diagnostic-search",
    );
  });

  it("keeps identifier questions targeted even when they mention the repository", () => {
    expect(classifyRetrievalIntent("How is ZodConfigSchema used in this repository?").intent).toBe(
      "targeted-code-search",
    );
  });

  it("keeps pure stop-word prompts in clarification-needed", () => {
    expect(classifyRetrievalIntent("the and for of").intent).toBe("clarification-needed");
  });

  it.each(["...", " -- .. -- ", "??? !!!", "___ ... ---"])(
    "keeps punctuation-only prompts in clarification-needed: %s",
    (text) => {
      expect(classifyRetrievalIntent(text).intent).toBe("clarification-needed");
    },
  );

  // ─── Polyglot ecosystem project-metadata routing (registry-driven) ──────────────
  // Regression target: "Which Java version does this project use?" previously fell through to a
  // generic code search because PROJECT_METADATA_PATTERNS only knew the JS/TS ecosystem.
  it.each([
    "Which Java version does this project use?",
    "Welche Java-Version nutzt dieses Projekt?",
    "What Maven compiler release is configured in the pom.xml?",
    "Which Go version and toolchain does this module require?",
    "Welche Go-Version erwartet dieses Modul?",
    "What Rust edition does this crate target?",
    "Which Python version is required to build?",
    "Which .NET target framework does this solution use?",
    "What C++ standard does CMake enforce here?",
    "Which Ruby version is pinned for this project?",
    "What PHP version does composer require?",
    "Which Terraform version does this configuration require?",
    "Which base image does the Dockerfile use?",
    "Which Kubernetes / Helm chart version is deployed?",
  ])("classifies polyglot project-metadata query: %s", (text) => {
    expect(classifyRetrievalIntent(text).intent).toBe("project-metadata");
  });

  // ─── No-regression / no-misrouting guards ───────────────────────────────────────
  // These guard against the registry OVER-triggering project-metadata on ordinary questions. (Note:
  // the pre-existing classifier intentionally routes the bare word "build" to project-metadata; the
  // registry deliberately contributes only high-precision terms and no bare ambiguous tokens such
  // as "go", "c", "build", or "schema".)
  it.each([
    ["How is ZodConfigSchema used in this repository?", "targeted-code-search"],
    ["How do I go to the settings page from the dashboard?", "targeted-code-search"],
    ["Give me an overview of this codebase structure.", "repository-overview"],
    ["Warum bekomme ich HTTP 503 im Chat?", "diagnostic-search"],
  ])("does not misroute ordinary query %s -> %s", (text, expected) => {
    expect(classifyRetrievalIntent(text).intent).toBe(expected);
  });
});
