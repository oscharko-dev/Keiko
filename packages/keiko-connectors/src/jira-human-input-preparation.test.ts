import { describe, expect, it } from "vitest";
import type { JiraHumanInputView } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { privateJiraCustodyFixture } from "../../../tests/support/jira-private-custody-fixture.js";
import { prepareJiraHumanInput } from "./jira-human-input-preparation.js";

const PASSWORD = ["synthetic", "held call", "input"].join(" ");
describe("existing held-call human information continuation", () => {
  it("publishes the pending view before waiting, returns the original bound revision and never claims a secret", async () => {
    const f = privateJiraCustodyFixture("jira.login"); const views: JiraHumanInputView[] = [];
    const selected = await prepareJiraHumanInput(f.inputs, f.binding, (view) => {
      views.push(view);
      if (view.state === "awaiting-input") f.inputs.submit(view.requestId, f.binding, view.revision, { password: PASSWORD });
    }, new AbortController().signal);
    expect(views.map((view) => view.state)).toEqual(["awaiting-input", "ready"]);
    expect(selected.binding).toEqual(f.binding);
    expect(f.inputs.inspect(selected.requestId, f.binding)).toMatchObject({ state: "ready", revision: selected.revision });
    expect(JSON.stringify(views)).not.toContain(PASSWORD);
    expect(f.privateInputs.claim(selected.requestId, selected.binding, selected.revision)).toEqual({ password: PASSWORD });
  });
  it("clears human values when the existing call is cancelled while its ready view is being persisted", async () => {
    const f = privateJiraCustodyFixture("jira.login"); const abort = new AbortController(); let id = "";
    await expect(prepareJiraHumanInput(f.inputs, f.binding, (view) => {
      id = view.requestId;
      if (view.state === "awaiting-input") f.inputs.submit(view.requestId, f.binding, view.revision, { password: PASSWORD });
      else abort.abort();
    }, abort.signal)).rejects.toMatchObject({ code: "cancelled" });
    expect(f.inputs.inspect(id, f.binding)?.state).toBe("cancelled");
    expect([...f.sealedPortEntries.values()].join("")).not.toContain(PASSWORD);
  });
});
