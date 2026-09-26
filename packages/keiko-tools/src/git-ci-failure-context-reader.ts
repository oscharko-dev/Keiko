import type { CommandResult } from "./types.js";
import { canonicalise } from "@oscharko-dev/keiko-security/hashing";
import {
  gitDeliveryObservationFailure,
  type GitDeliveryObservationFailureReason,
} from "@oscharko-dev/keiko-contracts/runtime/git-delivery-provider";
import { CommandCancelledError, CommandDeniedError, OutputLimitError } from "./errors.js";
import { buildGitCiReadArgv } from "./git-ci-read-argv.js";
import { readGitProviderValue } from "./git-provider-value.js";
import { readGitProviderPages, type GitProviderReadRunner } from "./git-provider-observation.js";
import { parseGitPrIdentity } from "./git-pr-identity.js";
import { buildGitCiFailureArgv, type GitCiFailureReadKind } from "./git-ci-failure-argv.js";
import {
  GIT_CI_FAILURE_MAX_INPUT_BYTES,
  GitCiFailureContextError,
  ciFailureObject,
  type GitCiFailureContextInput,
  type GitCiFailureSource,
} from "./git-ci-failure-context-types.js";

export function failure(reason: GitDeliveryObservationFailureReason): never {
  throw new GitCiFailureContextError(gitDeliveryObservationFailure(reason));
}
export class GitCiFailureReader {
  public calls = 0;
  public bytes = 0;
  private readonly run: GitProviderReadRunner;
  public constructor(private readonly input: GitCiFailureContextInput) {
    this.run = async (argv): Promise<CommandResult | Error> => {
      this.admit();
      if (this.calls >= 20)
        return new OutputLimitError("CI diagnostic read cap", GIT_CI_FAILURE_MAX_INPUT_BYTES);
      this.calls += 1;
      const result = await input.run(argv);
      this.admit();
      if (!(result instanceof Error))
        this.bytes +=
          Buffer.byteLength(result.stdout, "utf8") + Buffer.byteLength(result.stderr, "utf8");
      return this.bytes > GIT_CI_FAILURE_MAX_INPUT_BYTES
        ? new OutputLimitError("CI diagnostic byte cap", GIT_CI_FAILURE_MAX_INPUT_BYTES)
        : result;
    };
  }
  public admit(): void {
    if (this.input.signal?.aborted === true)
      throw new CommandCancelledError("CI diagnostics cancelled");
    if (!this.input.stillAuthorized())
      throw new CommandDeniedError("CI diagnostic authority denied", "gh");
  }
  private async value(argv: readonly string[]): Promise<Record<string, unknown>> {
    const result = await readGitProviderValue({
      run: this.run,
      argv,
      ...(this.input.signal === undefined ? {} : { signal: this.input.signal }),
    });
    if (result.status === "unavailable") throw new GitCiFailureContextError(result.failure);
    if (!ciFailureObject(result.value)) failure("malformed-response");
    return result.value;
  }
  public async checkPullRequest(): Promise<void> {
    const expected = this.input.facts.identity;
    const result = await this.value(
      buildGitCiReadArgv(
        "pull-request",
        {
          ownerAndRepo: expected.repository,
          prExternalId: String(expected.number),
          baseBranchName: expected.baseRef,
          headSha: expected.headSha,
        },
        1,
      ),
    );
    const identity = parseGitPrIdentity(result.identity, expected.repository);
    if (
      identity === undefined ||
      canonicalise(identity) !== canonicalise(expected) ||
      result.repositoryId !== this.input.facts.repositoryId
    )
      failure("revision-changed");
  }
  public async source(source: GitCiFailureSource): Promise<Record<string, unknown>> {
    const value = await this.value(this.argv(source.kind, source));
    const kind = source.kind === "check-run" ? "check-runs" : "actions/runs";
    const url = `https://api.github.com/repos/${this.input.facts.identity.repository}/${kind}/${String(source.id)}`;
    if (value.url !== url) failure("revision-changed");
    for (const key of sourceKeys(source.kind)) {
      if (canonicalise(value[key]) !== canonicalise(source.metadata[key]))
        failure("revision-changed");
    }
    if (source.kind === "workflow-run" && value.repository !== this.input.facts.identity.repository)
      failure("revision-changed");
    return value;
  }
  public async entries(source: GitCiFailureSource): Promise<readonly unknown[]> {
    const kind = source.kind === "check-run" ? "annotations" : "jobs";
    const result = await readGitProviderPages({
      run: this.run,
      argv: (page) => this.argv(kind, source, page),
      pageSize: 50,
      maxPages: 2,
      maxBytes: GIT_CI_FAILURE_MAX_INPUT_BYTES,
      counted: kind === "jobs",
      ...(this.input.signal === undefined ? {} : { signal: this.input.signal }),
    });
    if (!result.completeness.complete)
      throw new GitCiFailureContextError(result.completeness.failure);
    if (kind === "annotations" && result.values.length !== source.metadata.annotationCount)
      failure("revision-changed");
    return result.values;
  }
  private argv(
    kind: GitCiFailureReadKind,
    source: GitCiFailureSource,
    page = 1,
  ): readonly string[] {
    return buildGitCiFailureArgv(
      kind,
      { repository: this.input.facts.identity.repository, id: source.id, attempt: source.attempt },
      page,
    );
  }
}
function sourceKeys(kind: GitCiFailureSource["kind"]): readonly string[] {
  return kind === "check-run"
    ? ["id", "name", "headSha", "appId", "suiteId", "status", "conclusion", "annotationCount"]
    : [
        "id",
        "workflowId",
        "path",
        "headSha",
        "event",
        "status",
        "conclusion",
        "runAttempt",
        "repositoryId",
        "headRepositoryId",
        "createdAt",
        "updatedAt",
        "pullRequests",
        "referencedWorkflows",
      ];
}
