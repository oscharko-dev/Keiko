export async function runCliCheck({
  check,
  error,
  failureFallback,
  failurePrefix,
  log,
  passMessage,
}) {
  try {
    const problems = await check();
    if (problems.length > 0) throw new Error(problems[0]);
    log(passMessage);
    return 0;
  } catch (error_) {
    const message = error_ instanceof Error ? error_.message : failureFallback;
    error(`${failurePrefix}: FAIL — ${message}`);
    return 1;
  }
}
