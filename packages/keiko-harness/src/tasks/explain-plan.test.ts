import { describe, expect, it } from "vitest";
import { buildExplainPlan } from "./explain-plan.js";

describe("buildExplainPlan", () => {
  it("is read-only: tools, patch, and verification are all disallowed", () => {
    const plan = buildExplainPlan({ filePath: "src/foo.ts" });
    expect(plan.allowsTools).toBe(false);
    expect(plan.allowsPatch).toBe(false);
    expect(plan.allowsVerification).toBe(false);
  });

  it("targets the requested file and seeds a system + user message", () => {
    const plan = buildExplainPlan({ filePath: "src/foo.ts", question: "what does bar do?" });
    expect(plan.targetFile).toBe("src/foo.ts");
    expect(plan.messages.map((m) => m.role)).toEqual(["system", "user"]);
    expect(plan.messages[1]?.content).toContain("what does bar do?");
  });

  it("includes the file path in the user message when no question is given", () => {
    const plan = buildExplainPlan({ filePath: "src/baz.ts" });
    expect(plan.messages[1]?.content).toContain("src/baz.ts");
  });

  // KEIKO-0335: the "no context" disclosure is a load-bearing prompt affordance — the model is
  // told, verbatim, that no excerpt was provided and to name that limitation before answering.
  // A future edit that drops or garbles the string would silently start asking the model to
  // hallucinate about a file it has not seen. Assert the exact production text.
  it("emits the exact no-context disclosure when no excerpt is provided", () => {
    const plan = buildExplainPlan({ filePath: "src/baz.ts" });
    expect(plan.messages[1]?.content).toContain(
      "File excerpt: not available. State that limitation before answering.",
    );
  });

  it("grounds the prompt with provided file context", () => {
    const plan = buildExplainPlan({
      filePath: "src/baz.ts",
      context: "--- src/baz.ts ---\nexport const value = 1;",
    });
    expect(plan.messages[0]?.content).toContain("Do not infer");
    expect(plan.messages[1]?.content).toContain("export const value = 1;");
  });

  // KEIKO-0550: a caller-supplied context: "" is a distinct value from an omitted context field,
  // but both mean "no excerpt was provided" and must render identically — otherwise the model
  // could read a bare "File excerpt:\n" as "an excerpt was checked and found empty" rather than
  // "no excerpt was supplied at all".
  it("treats an empty-string context the same as an omitted context", () => {
    const omitted = buildExplainPlan({ filePath: "src/baz.ts" });
    const empty = buildExplainPlan({ filePath: "src/baz.ts", context: "" });
    expect(empty.messages).toEqual(omitted.messages);
  });
});
