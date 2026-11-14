// A stopped lab stack whose network Docker removed is reported with its remedy (#4369), instead of a
// bare Docker error from `compose up`.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MISSING_NETWORK_REMEDY,
  containersOfMissingNetwork,
} from "../testing/jira-chat-lab/lab-services.mjs";

const session = { project: "keiko-jira-4081-aaaaaaaaaaaa" };
const docker =
  ({ ids = ["c1", "c2"], networks = ["n1"], containers }) =>
  async (args) => {
    if (args[0] === "ps") return ids.join("\n");
    if (args[0] === "network") return networks.join("\n");
    return JSON.stringify(containers);
  };
const container = (name, networkId) => ({
  Name: `/${name}`,
  NetworkSettings: {
    Networks: { "keiko-jira-4081-aaaaaaaaaaaa_default": { NetworkID: networkId } },
  },
});

describe("containers of a removed network", () => {
  it("lists the containers whose network no longer exists, with the network's name", async () => {
    const found = await containersOfMissingNetwork(
      session,
      docker({ containers: [container("a-jira-1", "gone"), container("a-database-1", "n1")] }),
    );
    expect(found).toEqual([
      { container: "a-jira-1", network: "keiko-jira-4081-aaaaaaaaaaaa_default" },
    ]);
  });

  it("is empty for a healthy stack and for a session that has no containers yet", async () => {
    expect(
      await containersOfMissingNetwork(session, docker({ containers: [container("a", "n1")] })),
    ).toEqual([]);
    expect(await containersOfMissingNetwork(session, docker({ ids: [], containers: [] }))).toEqual(
      [],
    );
  });

  it("gives no diagnosis, and no failure, when Docker does not answer in JSON (compose reports its own error)", async () => {
    const mute = async (args) => (args[0] === "inspect" ? "" : args[0] === "ps" ? "c1" : "n1");
    expect(await containersOfMissingNetwork(session, mute)).toEqual([]);
  });

  it("states the remedy: remove exactly those containers, never a volume, then start again", () => {
    expect(MISSING_NETWORK_REMEDY).toContain("`docker rm` exactly those containers");
    expect(MISSING_NETWORK_REMEDY).toContain("never with -v");
    expect(MISSING_NETWORK_REMEDY).toContain("named volumes");
  });

  it("is wired into the session start before compose runs", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "../testing/jira-chat-lab/session.mjs"),
      "utf8",
    );
    expect(source).toContain("containersOfMissingNetwork(session)");
    expect(source.indexOf("containersOfMissingNetwork(session)")).toBeLessThan(
      source.indexOf('"compose"'),
    );
  });
});
