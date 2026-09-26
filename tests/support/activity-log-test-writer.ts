// Vitest setup for every suite that runs product server or CLI code (#3532).
//
// A production process never writes its Activity Log to nowhere: without `KEIKO_STATE_DIR` the
// process-wide server logger resolves the CLI's default runtime state directory (`<cwd>/.keiko`).
// A unit test that configures no state directory must not write into the checkout it runs from,
// so this setup EXPLICITLY injects the test writer — the only way the silent writer is reachable.
// Readiness then reports the writer as `test-injected`, never as production. A test that sets
// `KEIKO_STATE_DIR` still gets the real production file writer.
//
// The marker is the global symbol `installActivityLogTestWriter` (keiko-activity-log
// `src/server-logger.ts`) reads. It is set directly rather than through that function so
// this setup never loads the server module graph into suites that do not need it; the shared
// `Symbol.for` key is what makes one marker visible to every module instance (source and dist).
const ACTIVITY_LOG_TEST_WRITER = Symbol.for("@oscharko-dev/keiko-server/activity-log-test-writer");

(globalThis as Record<symbol, unknown>)[ACTIVITY_LOG_TEST_WRITER] = true;
