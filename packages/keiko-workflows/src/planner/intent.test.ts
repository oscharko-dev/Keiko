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

  it.each([
    "Why does the React build fail?",
    "Why is the Vitest test failing?",
    "Why does checkout dataflow break after the API call?",
  ])("prioritizes diagnostic intent over project metadata terms: %s", (text) => {
    expect(classifyRetrievalIntent(text).intent).toBe("diagnostic-search");
  });

  it("keeps high-precision framework inventory questions as project metadata", () => {
    expect(classifyRetrievalIntent("Which React version does this project use?").intent).toBe(
      "project-metadata",
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

  // ─── ReDoS regression guard (SonarCloud S8786) ───────────────────────────────────
  // TARGETED_CODE_PATTERNS' old "path" pattern (`(?:[\w.-]+/)+[\w.-]+`) and "identifier" pattern
  // (`[A-Za-z_$][A-Za-z0-9_$]*[A-Z][A-Za-z0-9_$]*`) each combined an unbounded quantifier with an
  // unanchored scan over a required-but-possibly-absent character, which made a single long run of
  // ordinary word characters (no "/" for the path pattern, no uppercase letter for the identifier
  // pattern) quadratic to reject. A single query built from one long run of "a" characters hits
  // both: it never matches DIAGNOSTIC/PROJECT_METADATA/REPOSITORY_OVERVIEW patterns, so
  // classification falls through to TARGETED_CODE_PATTERNS and both rewritten patterns run against
  // it (twice: once against the raw text, once against the normalized text).
  it("classifies a long ambiguous run of word characters without superlinear slowdown", () => {
    const adversarial = "a".repeat(20_000);
    const start = Date.now();
    const result = classifyRetrievalIntent(adversarial);
    const elapsedMs = Date.now() - start;
    expect(elapsedMs).toBeLessThan(1000);
    expect(result.intent).toBe("targeted-code-search");
  });

  // A homogeneous run of a single word character (the case above) only ever has ONE `\b`-satisfying
  // start position, so it is actually linear for the "identifier" pattern even when that pattern's
  // quantifiers are unbounded -- it does not exercise the real remaining vulnerability. `$` is part
  // of the "identifier" pattern's character classes but is NOT a `\w` character for `\b` purposes, so
  // alternating word/`$` characters (e.g. "a$a$a$...") produces O(n) independent `\b`-satisfying
  // start positions instead of one. With unbounded leading-run quantifiers, each of those O(n) start
  // positions costs O(remaining length) to disprove (no uppercase letter ever appears), giving true
  // O(n^2) blowup. "zzz " is prepended so the `searchableTokens` gate is satisfied without the
  // payload itself matching any DIAGNOSTIC/PROJECT_METADATA pattern, forcing classification through
  // to TARGETED_CODE_PATTERNS exactly as it would for a real, attacker-controlled query.
  it("classifies an alternating word/dollar run without superlinear slowdown", () => {
    const adversarial = "zzz " + "a$".repeat(40_000);
    const start = Date.now();
    const result = classifyRetrievalIntent(adversarial);
    const elapsedMs = Date.now() - start;
    expect(elapsedMs).toBeLessThan(1000);
    expect(result.intent).toBe("targeted-code-search");
  });

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
