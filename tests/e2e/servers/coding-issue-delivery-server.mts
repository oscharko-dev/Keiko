import { pathToFileURL } from "node:url";
import type { DraftDeliveryDependencies } from "../../../packages/keiko-server/src/gitDelivery/draftDeliveryTypes.js";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { COMMIT_EDITED, COMMIT_ORIGINAL, COMMIT_TARGET } from "../support/coding-issue-commit.js";
import {
  DELIVERY_LAUNCHER_SECRET,
  DELIVERY_PORT,
  DELIVERY_REPOSITORY,
  DELIVERY_TEMPLATE,
  DELIVERY_URL,
  deliveryManagedRoot,
  deliveryRepository,
  deliveryRevisionPath,
  deliveryStateDir,
} from "../support/coding-issue-delivery.js";
import {
  initializeDeliveryRemote,
  installDeliveryTransport,
} from "./coding-issue-delivery-transport.mjs";
import {
  deliveryDescriptionGatewayConfig,
  startDeliveryDescriptionModel,
} from "./coding-issue-description-model.mjs";
import { runCodingRuntimeJourneyServer } from "./coding-runtime-server-shared.mjs";

export async function runIssueDeliveryServer(
  options: {
    readonly ciReader?: DraftDeliveryDependencies["ciReader"];
    readonly installTransport?: (stateDir: string) => { readonly realGit: string };
    readonly port?: number;
  } = {},
): Promise<void> {
  const stateDir = deliveryStateDir();
  mkdirSync(stateDir, { recursive: true });
  const transport = (options.installTransport ?? installDeliveryTransport)(stateDir);
  const port = options.port ?? DELIVERY_PORT;
  const modelPort = port - 1;
  await startDeliveryDescriptionModel(stateDir, modelPort);
  const bffStateRoot = join(stateDir, "bff-state");
  mkdirSync(join(bffStateRoot, "ui-db"), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(bffStateRoot, "ui-db", "keiko.config.json"),
    `${JSON.stringify(deliveryDescriptionGatewayConfig(modelPort), null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  await runCodingRuntimeJourneyServer({
    fixtureId: "draft-delivery-3387",
    fixtureLabel: "Draft delivery 3387",
    runtime: "scripted",
    includeQuestion: false,
    defaultPort: port,
    ...(options.ciReader === undefined ? {} : { ciReader: options.ciReader }),
    originalContent: COMMIT_ORIGINAL,
    editedContent: COMMIT_EDITED,
    targetRelativePath: COMMIT_TARGET,
    stateDir: deliveryStateDir,
    repositoryRoot: deliveryRepository,
    managedRoot: deliveryManagedRoot,
    launcherSessionSecret: DELIVERY_LAUNCHER_SECRET,
    commit: true,
    delivery: true,
    issue: {
      remoteUrl: DELIVERY_URL,
      initialize: (dir): void => {
        initializeDeliveryIssue(dir, transport.realGit);
      },
      port: { readJson: (args): Promise<unknown> => readDeliveryIssue(stateDir, args) },
      observeGatewayRequest: (): void => undefined,
    },
  });
}
function initializeDeliveryIssue(dir: string, realGit: string): void {
  const root = deliveryRepository(dir);
  mkdirSync(join(root, ".github"), { recursive: true });
  writeFileSync(join(root, ".github", "pull_request_template.md"), DELIVERY_TEMPLATE);
  for (const args of [
    ["add", ".github/pull_request_template.md"],
    ["commit", "--quiet", "-m", "fixture: preserve repository template"],
    ["update-ref", "refs/remotes/origin/main", "HEAD"],
  ])
    execFileSync(realGit, args, { cwd: root, timeout: 30_000 });
  writeFileSync(deliveryRevisionPath(dir), "1");
  initializeDeliveryRemote(dir, realGit);
}
function readDeliveryIssue(stateDir: string, args: readonly string[]): Promise<unknown> {
  const endpoint = args[1] ?? "";
  const number = Number(
    new RegExp(`^/repos/${DELIVERY_REPOSITORY}/issues/(\\d+)(?:$|/)`, "u").exec(endpoint)?.[1],
  );
  if (!Number.isSafeInteger(number) || number < 42 || number > 52)
    return Promise.reject(new Error("delivery-fixture-issue-target-denied"));
  if (endpoint.includes("comments?")) return Promise.resolve([]);
  return Promise.resolve({
    id: `provider-${String(number)}`,
    nodeId: `I_fixture_${String(number)}`,
    state: "open",
    isPullRequest: false,
    title: "Implement the accepted issue",
    body: `Update the constant and verify it. Revision ${readFileSync(deliveryRevisionPath(stateDir), "utf8")}.`,
    comments: 0,
    url: `https://github.com/${DELIVERY_REPOSITORY}/issues/${String(number)}`,
  });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href)
  await runIssueDeliveryServer();
