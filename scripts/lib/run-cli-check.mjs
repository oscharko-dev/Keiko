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
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : failureFallback;
    error(`${failurePrefix}: FAIL — ${message}`);
    return 1;
  }
}
