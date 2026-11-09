import type { ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import {
  nativeBuildCertificateFiles,
  type NativeBuildCertificateFiles,
} from "@oscharko-dev/keiko-sandbox";

/**
 * The certificate bundles the operator names with NODE_EXTRA_CA_CERTS or SSL_CERT_FILE reach a
 * native run read-only (#4271): the run inherits the variable, so its TLS clients read the file,
 * whose usually credential-shaped name (`*.pem`) the kernel's credential-name rule would otherwise
 * deny. One body-free line per native launch records how many variables named a file and how many
 * of them were admitted, so a certificate failure inside a run is reconstructable without a path.
 */
const NATIVE_CERTIFICATES_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "coding-runtime.native-certificates.admitted",
  category: "process",
  owner: "keiko-server",
  emitter: "coding-runtime.opencodeNativeCertificates.recordNativeCertificatesAdmitted",
  fields: {
    namedCount: { type: "integer", dataClass: "count", required: true },
    admittedCount: { type: "integer", dataClass: "count", required: true },
    fileCount: { type: "integer", dataClass: "count", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "capability",
  failureClasses: ["coding-runtime-native-policy"],
  proofIds: ["coding-runtime.native-certificates.admitted.emitted-line"],
  releaseImpact: "patch",
});

function recordNativeCertificatesAdmitted(
  sink: ServerLogSink,
  runId: string,
  certificates: NativeBuildCertificateFiles,
): void {
  sink.write(
    activityLogEvent(
      NATIVE_CERTIFICATES_OPERATION,
      { level: "info", correlationId: runId },
      {
        namedCount: certificates.namedCount,
        admittedCount: certificates.admittedCount,
        fileCount: certificates.files.length,
      },
    ),
  );
}

/** The `certificateReadFiles` field of a native filesystem plan, recorded on the Activity Log. */
export function nativeCertificateReadFilesField(
  sink: ServerLogSink,
  runId: string,
  env: Readonly<Record<string, string | undefined>>,
  home: string,
): { readonly certificateReadFiles?: readonly string[] } {
  const certificates = nativeBuildCertificateFiles(env, home);
  recordNativeCertificatesAdmitted(sink, runId, certificates);
  return certificates.files.length === 0 ? {} : { certificateReadFiles: certificates.files };
}
