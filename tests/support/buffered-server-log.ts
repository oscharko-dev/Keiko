// The in-memory sink remains a test-only implementation inside the Activity Log package. Tests in
// other packages reach it through this repository test seam, never through a production package
// entry point.
export {
  createBufferedServerLogSink,
  type BufferedServerLogSink,
} from "../../packages/keiko-activity-log/src/server-log.js";
