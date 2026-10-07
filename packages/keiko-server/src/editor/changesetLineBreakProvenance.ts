import type { EditorAgentAction } from "@oscharko-dev/keiko-contracts";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import type { PatchLineBreakMarkers } from "@oscharko-dev/keiko-tools";
import type { MaterializedPatchRegistry } from "../coding-runtime/materializedPatchRegistry.js";
import { correlationIdOrUnknown } from "../correlation.js";
import { processServerLogSink } from "../process-log-sink.js";

export type ChangesetProvenanceStage = "admission" | "result";

type ChangesetProvenance = "materialized" | "unregistered" | "registry-absent";

const CHANGESET_PROVENANCE_COUNT_FIELD = {
  type: "integer",
  dataClass: "count",
  required: false,
} as const;

// PR #3876 review: whether the diff of a changeset is one the server rendered itself, so that
// keiko-tools' collapsed-diff heuristic may be lifted for it. One line per decision, body-free: the
// stage, what the registry answered, the diff's size and digest, and the registry's own counts, so
// a refusal after a long review reads as an ended registration (expired counts) and not as an
// engine defect. No path, no diff text.
const CHANGESET_PROVENANCE_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "editor.agent.changeset-provenance",
  category: "security",
  owner: "keiko-server",
  emitter: "editor.changesetLineBreakProvenance.changesetLineBreakMarkers",
  fields: {
    stage: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["admission", "result"],
    },
    provenance: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["materialized", "unregistered", "registry-absent"],
    },
    patchBytes: { type: "integer", dataClass: "count", required: true },
    // Absent with `registry-absent`: no registry answered, so there is no key to report.
    patchSha256: { type: "string", dataClass: "digest", required: false, maxLength: 64 },
    registryEntries: CHANGESET_PROVENANCE_COUNT_FIELD,
    registryEvicted: CHANGESET_PROVENANCE_COUNT_FIELD,
    registryExpired: CHANGESET_PROVENANCE_COUNT_FIELD,
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "capability",
  failureClasses: ["coding-editor-mutation"],
  proofIds: ["editor.agent.changeset-provenance.emitted-line"],
  releaseImpact: "patch",
});

export interface ChangesetLineBreakProvenanceInput {
  readonly action: EditorAgentAction;
  readonly registry: Pick<MaterializedPatchRegistry, "lookup" | "stats"> | undefined;
  readonly stage: ChangesetProvenanceStage;
  readonly correlationId: string | undefined;
}

/**
 * How the route reads the diff of an `applyChangeset` action for escaped line-break text.
 *
 * keiko-tools refuses a diff that spells a backslash-n before `+`, `-` or a space: its guard against
 * a model that collapses a diff's lines into one. The edit port of the coding runtime renders its
 * diff itself, from the bytes of a governed read of the real file, and registers its exact text, so
 * such text in it is file text. Only a registered text is read verbatim; a diff from any other
 * source, an expired registration and a missing registry keep the default. The model and the
 * browser can neither write the registry nor name a digest in a request.
 *
 * The decision is made on the diff as the action carries it, once per stage, and covers every
 * validation of that stage, the diff projected from the selected files included: a projection only
 * drops files from a diff that was validated whole, it adds no text.
 */
export function changesetLineBreakMarkers(
  input: ChangesetLineBreakProvenanceInput,
): PatchLineBreakMarkers {
  const patch = input.action.type === "applyChangeset" ? input.action.changeset?.patch : undefined;
  if (patch === undefined) return "reject";
  const patchBytes = Buffer.byteLength(patch, "utf8");
  const evidence = { stage: input.stage, patchBytes };
  const correlationId = correlationIdOrUnknown(input.correlationId);
  if (input.registry === undefined) {
    recordChangesetProvenance(correlationId, { ...evidence, provenance: "registry-absent" });
    return "reject";
  }
  const { registered, patchSha256 } = input.registry.lookup(patch);
  const stats = input.registry.stats();
  recordChangesetProvenance(correlationId, {
    ...evidence,
    provenance: registered ? "materialized" : "unregistered",
    patchSha256,
    registryEntries: stats.entries,
    registryEvicted: stats.evicted,
    registryExpired: stats.expired,
  });
  return registered ? "verbatim" : "reject";
}

interface ChangesetProvenanceFields {
  readonly stage: ChangesetProvenanceStage;
  readonly provenance: ChangesetProvenance;
  readonly patchBytes: number;
  readonly patchSha256?: string;
  readonly registryEntries?: number;
  readonly registryEvicted?: number;
  readonly registryExpired?: number;
}

function recordChangesetProvenance(correlationId: string, fields: ChangesetProvenanceFields): void {
  processServerLogSink().write(
    activityLogEvent(CHANGESET_PROVENANCE_OPERATION, { correlationId, level: "info" }, fields),
  );
}
