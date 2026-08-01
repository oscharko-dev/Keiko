function isJsonObject(value) {
  return value !== null && !Array.isArray(value) && typeof value === "object";
}

function parsePolicy(source) {
  try {
    const value = JSON.parse(source);
    return isJsonObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function validateCodSpeedPolicy(source) {
  const policy = parsePolicy(source);
  if (policy === undefined) {
    return ["codspeedPolicy must contain a valid JSON object"];
  }
  const checks = [
    [policy.schemaVersion, 2, "CodSpeed policy schema version must remain 2"],
    [policy.project, "oscharko-dev/Keiko", "CodSpeed policy must bind the Keiko project"],
    [policy.regressionThresholdPercent, 5, "CodSpeed regression threshold must remain 5%"],
    [policy.failOnRegression, false, "CodSpeed regressions must remain informational"],
    [policy.pullRequestReport, "always", "CodSpeed must report every pull-request head"],
  ];
  return checks.filter(([actual, expected]) => actual !== expected).map(([, , finding]) => finding);
}
