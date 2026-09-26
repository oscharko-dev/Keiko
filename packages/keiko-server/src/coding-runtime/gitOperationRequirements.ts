import type {
  CodingWorkbenchActionClass,
  CodingWorkbenchConnectorScope,
  GitRepositoryAgentOperationKind,
} from "@oscharko-dev/keiko-contracts";

export interface GitOperationRequirement {
  readonly actionClasses: readonly CodingWorkbenchActionClass[];
  readonly connectorScopes: readonly CodingWorkbenchConnectorScope[];
  readonly needsNetwork: boolean;
}

const SOURCE_CONTROL_READ = "source-control.read" satisfies CodingWorkbenchConnectorScope;
const SOURCE_CONTROL_WRITE = "source-control.write" satisfies CodingWorkbenchConnectorScope;

const READ_REQUIREMENT = requirement(["workspace-read"], [SOURCE_CONTROL_READ], false);
const LOCAL_WRITE_REQUIREMENT = requirement(["workspace-write"], [SOURCE_CONTROL_WRITE], false);
const COMMIT_REQUIREMENT = requirement(["delivery-substrate"], [SOURCE_CONTROL_WRITE], false);
const FETCH_REQUIREMENT = requirement(
  ["delivery-substrate", "network-egress"],
  [SOURCE_CONTROL_READ],
  true,
);
const REMOTE_WRITE_REQUIREMENT = requirement(
  ["delivery-substrate", "network-egress"],
  [SOURCE_CONTROL_WRITE],
  true,
);

const GIT_OPERATION_REQUIREMENTS: Readonly<
  Record<GitRepositoryAgentOperationKind, GitOperationRequirement>
> = Object.freeze({
  status: READ_REQUIREMENT,
  diff: READ_REQUIREMENT,
  "branch-list": READ_REQUIREMENT,
  "branch-create": LOCAL_WRITE_REQUIREMENT,
  "branch-switch": LOCAL_WRITE_REQUIREMENT,
  stage: LOCAL_WRITE_REQUIREMENT,
  unstage: LOCAL_WRITE_REQUIREMENT,
  commit: COMMIT_REQUIREMENT,
  fetch: FETCH_REQUIREMENT,
  pull: REMOTE_WRITE_REQUIREMENT,
  push: REMOTE_WRITE_REQUIREMENT,
  "pull-request": REMOTE_WRITE_REQUIREMENT,
  merge: REMOTE_WRITE_REQUIREMENT,
});

export function gitOperationRequirement(
  operation: GitRepositoryAgentOperationKind,
): GitOperationRequirement {
  return GIT_OPERATION_REQUIREMENTS[operation];
}

function requirement(
  actionClasses: readonly CodingWorkbenchActionClass[],
  connectorScopes: readonly CodingWorkbenchConnectorScope[],
  needsNetwork: boolean,
): GitOperationRequirement {
  return { actionClasses, connectorScopes, needsNetwork };
}
