import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { isRecord } from "@oscharko-dev/keiko-contracts/runtime/coding-context";
import {
  buildGroundedGatewayMessages,
  buildQuery,
} from "../packages/keiko-server/src/grounded-qa.js";
import { retrieveConnectedContextPack } from "../packages/keiko-server/src/grounded-orchestrator.js";
import { createBufferedServerLogSink } from "./support/buffered-server-log.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "./support/activity-log-proof.js";

const roots: string[] = [];
const NOW = 1_784_653_600_000;
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixtureText(value: unknown): string {
  if (
    !Array.isArray(value) ||
    !value.every((line: unknown): line is string => typeof line === "string")
  )
    throw new TypeError("Expected fixture source lines");
  return value.join("");
}

function springFixture(): { readonly root: string; readonly question: string } {
  const value: unknown = JSON.parse(
    readFileSync(
      new URL(
        "../scripts/testing/chat-skills-lab/fixtures/spring-quote-slice-heldout.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  if (
    !isRecord(value) ||
    !isRecord(value.files) ||
    !isRecord(value.tasks) ||
    typeof value.tasks.java !== "string"
  )
    throw new TypeError("Expected the existing Spring qualification fixture");
  const root = mkdtempSync(join(tmpdir(), "keiko-skill-conventions-"));
  roots.push(root);
  for (const [path, lines] of Object.entries(value.files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), fixtureText(lines));
  }
  return { root, question: value.tasks.java };
}

async function retrieve(
  root: string,
  question: string,
): Promise<{
  readonly pack: Awaited<ReturnType<typeof retrieveConnectedContextPack>>["pack"];
  readonly log: ReturnType<typeof createBufferedServerLogSink>;
}> {
  const log = createBufferedServerLogSink();
  const result = await retrieveConnectedContextPack(
    {
      workspaceRoot: root,
      scope: {
        schemaVersion: "1",
        scopeId: "skill-conventions",
        workspaceRoot: root,
        kind: "workspace-root",
        relativePaths: [],
        explicitConnection: true,
        conversationId: "chat",
        connectedAtMs: NOW,
      },
      query: buildQuery(question, () => NOW),
    },
    {
      correlationId: "source-conventions-observation",
      activityLog: log,
      nowMs: () => NOW,
      answerer: {
        answer: (): Promise<string> => Promise.reject(new Error("Unexpected model call")),
      },
    },
  );
  return { pack: result.pack, log };
}

function expectSourceObservation(
  log: ReturnType<typeof createBufferedServerLogSink>,
  count: number,
): void {
  const details = log.events.find(
    (event) => event.op === "search.connected-context.evidence-details",
  );
  expect(details?.correlationId).toBe("source-conventions-observation");
  expect(details?.extra).toMatchObject({
    activityDetailStatus: "complete",
    sourceDescriptorPathCount: count,
  });
  expectActivityLogProof(
    "search.connected-context.evidence-details.line",
    formatActivityLogProofLine(details ?? {}),
  );
  const serialized = JSON.stringify(log.events);
  expect(serialized).not.toContain("Approved project testing conventions");
  expect(serialized).not.toContain("docs/testing-conventions.md");
}

it("retains the requested approved conventions from the unchanged Spring skill question", async () => {
  const { root, question } = springFixture();
  const { pack, log } = await retrieve(root, question);
  const conventions = pack.files.find((file) => file.scopePath === "docs/testing-conventions.md");
  expect(conventions).toBeDefined();
  expect(pack.omitted.some((file) => file.scopePath === "docs/testing-conventions.md")).toBe(false);
  const messages = JSON.stringify(buildGroundedGatewayMessages(question, pack, (value) => value));
  expect(messages).toContain("org.springframework.boot.webmvc.test.autoconfigure.WebMvcTest");
  expect(messages).toContain("org.springframework.test.context.bean.override.mockito.MockitoBean");
  expectSourceObservation(log, 1);
});

it("records zero descriptor evidence when the source description is explicitly negated", async () => {
  const { root, question } = springFixture();
  writeFileSync(
    join(root, "docs/testing-conventions.md"),
    "# Not approved project testing conventions\n",
  );
  const { log } = await retrieve(root, question);
  expectSourceObservation(log, 0);
});
