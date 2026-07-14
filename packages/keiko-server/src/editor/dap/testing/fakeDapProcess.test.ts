import { describe, expect, it } from "vitest";
import { createDapProtocolClient } from "../dapProtocolClient.js";
import { createFakeDapProcess } from "./fakeDapProcess.js";

describe("fakeDapProcess", () => {
  it("answers deterministically without a real adapter dependency", async () => {
    const fake = createFakeDapProcess();
    const client = createDapProtocolClient({
      source: fake.source,
      sendFrame: (body) => {
        fake.sendFrame(body);
      },
    });
    await expect(
      client.request("threads", {}, { lane: "inspection", deadlineMs: 100 }),
    ).resolves.toStrictEqual({ threads: [] });
    expect(fake.sentCommands).toStrictEqual(["threads"]);
    client.dispose();
    fake.close();
  });
});
