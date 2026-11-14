import { describe, expect, it } from "vitest";
import { jiraConnectionHost, withConnectionInstance } from "./jira-connection-instance.js";

describe("the host of a base URL, as the person knows it (#4357)", () => {
  it.each([
    ["https://jira.example.invalid/context", "jira.example.invalid"],
    ["http://localhost:8080", "localhost:8080"],
    ["https://JIRA.Example.invalid:443/a/b?c=d#e", "jira.example.invalid"],
    ["https://u:p@jira.example.invalid", "jira.example.invalid"],
  ])("%s -> %s", (baseUrl, host) => {
    expect(jiraConnectionHost(baseUrl)).toBe(host);
  });
  it.each(["", "not a url", "jira.example.invalid", `https://${"a".repeat(300)}.invalid`])(
    "%j states nothing",
    (baseUrl) => {
      expect(jiraConnectionHost(baseUrl)).toBeUndefined();
    },
  );
});

describe("only a successful read gains the instance", () => {
  const url = "https://jira.example.invalid/context";
  it("adds the host to a successful result", async () => {
    const result = await withConnectionInstance(
      Promise.resolve({ data: { outcome: "succeeded", name: "ann" } }),
      url,
    );
    expect(result.data).toEqual({
      outcome: "succeeded",
      name: "ann",
      instance: { host: "jira.example.invalid" },
    });
  });
  it("leaves a failed result and a result without a stated host unchanged", async () => {
    const failed = { isError: true, data: { outcome: "failed", reason: "not-found" } } as const;
    expect(await withConnectionInstance(Promise.resolve(failed), url)).toEqual(failed);
    const ok = { data: { outcome: "succeeded" } } as const;
    expect(await withConnectionInstance(Promise.resolve(ok), "not a url")).toEqual(ok);
  });
});
