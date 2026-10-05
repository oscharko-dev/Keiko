import { Worker } from "node:worker_threads";
import {
  SUPPORT_REPORT_WORKER_TIMEOUT_MS,
  type ActivityLogErrorKind,
  type DesktopSupportReportResponse,
  type SupportReportFailure,
  type SupportIncidentDescriptorRecord,
  type SupportIncidentRecord,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { dismissSupportIncident } from "@oscharko-dev/keiko-activity-log";
import {
  prepareDesktopSupportReport,
  SupportReportError,
  DesktopSupportReportPreparationError,
} from "@oscharko-dev/keiko-activity-log/reader";
import { isValidCorrelationId } from "./correlation.js";
import { causeChain, keikoStackFrames, errorKindOf } from "./observability/index.js";

export type SupportReportJobReason =
  | SupportReportFailure
  | DesktopSupportReportPreparationError["reason"]
  | "busy"
  | "timeout"
  | "unavailable"
  | "cancelled";
export interface SupportReportWorkerFailure {
  readonly ok: false;
  readonly reason: SupportReportJobReason;
  readonly failureKind: ActivityLogErrorKind;
  readonly frames: readonly string[];
  readonly causeChain: readonly string[];
}
export type SupportReportWorkerMessage =
  | SupportReportWorkerFailure
  | { readonly ok: true; readonly report: DesktopSupportReportResponse }
  | { readonly kind: "prepare"; readonly correlationId?: string | undefined };
export interface SupportReportPreparedMessage {
  readonly kind: "prepared";
  readonly record: SupportIncidentDescriptorRecord;
}

export class SupportReportJobError extends Error {
  public readonly frames: readonly string[];
  public readonly causeChain: readonly string[];
  public readonly failureKind: string;
  public constructor(
    public readonly reason: SupportReportJobReason,
    error?: unknown,
    diagnostic?: SupportReportWorkerFailure,
  ) {
    super(`support report unavailable: ${reason}`, { cause: error });
    this.name = "SupportReportJobError";
    this.frames = diagnostic?.frames ?? keikoStackFrames(error);
    this.causeChain = diagnostic?.causeChain ?? causeChain(error);
    this.failureKind = diagnostic?.failureKind ?? errorKindOf(error);
  }
}

function prepareReport(
  worker: Worker,
  stateDir: string,
  correlationId: string | undefined,
  requestCorrelationId: string | undefined,
  onCreated: ((record: SupportIncidentRecord) => void) | undefined,
): void {
  try {
    const record = prepareDesktopSupportReport(
      stateDir,
      correlationId,
      requestCorrelationId,
      onCreated,
    );
    worker.postMessage({ kind: "prepared", record } satisfies SupportReportPreparedMessage);
  } catch (error) {
    throw new SupportReportJobError(
      error instanceof SupportReportError || error instanceof DesktopSupportReportPreparationError
        ? error.reason
        : "unavailable",
      error,
    );
  }
}

function reportMessageHandler(
  worker: Worker,
  stateDir: string,
  correlationId: string | undefined,
  resolve: (report: DesktopSupportReportResponse) => void,
  reject: Parameters<ConstructorParameters<PromiseConstructor>[0]>[1],
  requestCorrelationId: string | undefined,
  onCreated: ((record: SupportIncidentRecord) => void) | undefined,
): (value: SupportReportWorkerMessage) => void {
  let prepareStarted = false;
  return (value): void => {
    if ("kind" in value) {
      if (prepareStarted) {
        reject(new SupportReportJobError("unavailable"));
        return;
      }
      prepareStarted = true;
      if (
        (value.correlationId !== undefined && !isValidCorrelationId(value.correlationId)) ||
        (correlationId !== undefined && value.correlationId !== correlationId)
      ) {
        reject(new SupportReportJobError("selection-unavailable"));
        return;
      }
      try {
        prepareReport(worker, stateDir, value.correlationId, requestCorrelationId, onCreated);
      } catch (error) {
        reject(error);
      }
      return;
    }
    if (value.ok) resolve(value.report);
    else reject(new SupportReportJobError(value.reason, undefined, value));
  };
}

let running = false;

async function awaitReport(
  worker: Worker,
  stateDir: string,
  correlationId: string | undefined,
  signal?: AbortSignal,
  requestCorrelationId?: string,
  onCreated?: (record: SupportIncidentRecord) => void,
): Promise<DesktopSupportReportResponse> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  let accepting = true;
  try {
    return await new Promise<DesktopSupportReportResponse>((resolve, reject) => {
      cancel = (): void => {
        reject(new SupportReportJobError("cancelled"));
      };
      timer = setTimeout(() => {
        reject(new SupportReportJobError("timeout"));
      }, SUPPORT_REPORT_WORKER_TIMEOUT_MS);
      signal?.addEventListener("abort", cancel, { once: true });
      const onMessage = reportMessageHandler(
        worker,
        stateDir,
        correlationId,
        resolve,
        reject,
        requestCorrelationId,
        onCreated,
      );
      worker.on("message", (value: SupportReportWorkerMessage) => {
        if (accepting) onMessage(value);
      });
      worker.once("error", (error: Error) => {
        reject(new SupportReportJobError("unavailable", error));
      });
      worker.once("exit", () => {
        reject(new SupportReportJobError("unavailable"));
      });
      if (signal?.aborted === true) cancel();
    });
  } finally {
    accepting = false;
    clearTimeout(timer);
    if (cancel !== undefined) signal?.removeEventListener("abort", cancel);
  }
}

async function releaseWorker(worker: Worker | undefined): Promise<void> {
  try {
    await worker?.terminate();
  } catch (error) {
    throw new SupportReportJobError("unavailable", error);
  } finally {
    running = false;
  }
}

function reportAbandonedPreparation(
  stateDir: string,
  record: SupportIncidentRecord,
  correlationId: string | undefined,
): void {
  dismissSupportIncident(stateDir, record.incidentId, {
    correlationId,
    retirementReason: "abandoned",
  });
}

async function releaseReportJob(
  worker: Worker | undefined,
  completed: boolean,
  stateDir: string,
  owned: SupportIncidentRecord | undefined,
  correlationId: string | undefined,
): Promise<void> {
  let released = false;
  try {
    await releaseWorker(worker);
    released = true;
  } finally {
    if ((!completed || !released) && owned !== undefined)
      reportAbandonedPreparation(stateDir, owned, correlationId);
  }
}

/** Keep synchronous log scans off the request event loop, with one bounded worker per server. */
export async function runSupportReportJob(
  stateDir: string,
  correlationId?: string,
  signal?: AbortSignal,
  requestCorrelationId?: string,
  onPrepared?: (abandon: () => void) => void,
): Promise<DesktopSupportReportResponse> {
  if (running) throw new SupportReportJobError("busy");
  if (signal?.aborted === true) throw new SupportReportJobError("cancelled");
  running = true;
  let worker: Worker | undefined;
  let owned: SupportIncidentRecord | undefined;
  let completed = false;
  try {
    worker = new Worker(new URL("./support-report-worker.js", import.meta.url), {
      workerData: { stateDir, correlationId },
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    });
    const report = await awaitReport(
      worker,
      stateDir,
      correlationId,
      signal,
      requestCorrelationId,
      (record): void => {
        owned = record;
        onPrepared?.((): void => {
          reportAbandonedPreparation(stateDir, record, requestCorrelationId);
        });
      },
    );
    completed = true;
    return report;
  } catch (error) {
    if (error instanceof SupportReportJobError) throw error;
    throw new SupportReportJobError("unavailable", error);
  } finally {
    await releaseReportJob(worker, completed, stateDir, owned, requestCorrelationId);
  }
}
