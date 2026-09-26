# User Finding: `keiko start --port` Does Not Start On The Requested Port

## Keiko Version

1.1.7 / current dev branch.

## Platform

Windows.

## Browser

Not applicable. Startup fails before a healthy UI is available.

## Summary

`keiko start --port <Port>` does not reliably start the UI on the requested loopback port. The user does not receive an actionable flag-parsing error; startup falls through to the generic unhealthy-UI message.

## Steps To Reproduce

1. Run `keiko start --port <Port>` with a non-default loopback port.
2. Observe startup output and whether the UI becomes healthy on that port.

## Expected Result

The lifecycle launcher honors `--port <Port>` consistently across supported start surfaces, starts the UI on that loopback port, and reports the selected URL.

## Actual Result

Startup does not become healthy. The observed user-facing output is the generic form:

```text
keiko start: UI did not become healthy. Logs: <path to ui log>
```

## Evidence

Redacted user report only. No private logs or endpoints are included.

## User Impact

Degrades core workflow.

## Maintainer Release Impact Triage

Release-note category: Fix

Priority: P1

User-visible change: `keiko start --port <Port>` is honored consistently rather than failing with a generic unhealthy-UI message.

Release-note bullet: Fixed custom-port startup so `keiko start --port <Port>` reliably launches the UI on the requested loopback port.

Supported-from versions: Current dev branch / next patch release.

Affected state stores: Local runtime state directory (`.keiko` or `--state-dir`) only.

User action required and remediation: Retry startup after updating; no state migration required.

Internal-only rationale: Align every lifecycle entrypoint with the documented custom-port contract and pin it with regression coverage.

## Submission Safety

- [x] I have removed secrets, API keys, customer data, private endpoints, and private logs from this report.
