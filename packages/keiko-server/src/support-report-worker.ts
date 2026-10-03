import { parentPort, workerData } from "node:worker_threads";
import {
  readDesktopSupportReportSelection,
  createPreparedDesktopSupportReport,
  SupportReportError,
} from "@oscharko-dev/keiko-activity-log/reader";
import { causeChain, keikoStackFrames, errorKindOf } from "@oscharko-dev/keiko-activity-log";
import { activityLogErrorKindOr } from "@oscharko-dev/keiko-contracts/runtime/observability";
import type {
  SupportReportWorkerMessage,
  SupportReportWorkerFailure,
  SupportReportPreparedMessage,
} from "./support-report-job.js";

interface ReportWork {
  readonly stateDir: string;
  readonly correlationId?: string;
}
const work = workerData as ReportWork;

async function createReport(): Promise<SupportReportWorkerMessage> {
  const port = parentPort;
  if (port === null) throw new TypeError("Support report worker requires a parent port");
  // Read and select first. A mistyped correlation must never create or pin an incident.
  const selected = readDesktopSupportReportSelection(work.stateDir, work.correlationId);
  const selectedCorrelation = selected.correlationId;
  const preparation = new Promise<SupportReportPreparedMessage>((resolve) => {
    port.once("message", (message: SupportReportPreparedMessage) => {
      resolve(message);
    });
  });
  port.postMessage({
    kind: "prepare",
    correlationId: selectedCorrelation,
  } satisfies SupportReportWorkerMessage);
  const prepared = await preparation;
  return {
    ok: true,
    report: createPreparedDesktopSupportReport(
      work.stateDir,
      prepared.record,
      selectedCorrelation,
      selected.evidence,
    ),
  };
}

function serializeSupportReportWorkerFailure(error: unknown): SupportReportWorkerFailure {
  return {
    ok: false,
    reason: error instanceof SupportReportError ? error.reason : "unavailable",
    failureKind: activityLogErrorKindOr(errorKindOf(error), "internal"),
    frames: keikoStackFrames(error),
    causeChain: causeChain(error),
  };
}

try {
  parentPort?.postMessage(await createReport());
} catch (error) {
  // The main route owns logging. Transport only closed reasons and bounded diagnostic facts.
  parentPort?.postMessage(serializeSupportReportWorkerFailure(error));
}
