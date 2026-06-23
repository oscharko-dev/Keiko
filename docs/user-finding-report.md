# User-Finding Report Form

Use this form to report a bug or defect found while using Keiko. This page is intentionally a public, account-free intake template: it can be opened and filled without signing in to GitHub.

GitHub's native issue submission flow requires a signed-in GitHub account. If you do not have one, fill out the report below and send it through your established Keiko support, pilot, or account contact. A maintainer will transfer the redacted report into the tracked GitHub User-Finding issue form.

Do not include API keys, customer data, private screenshots, internal model endpoints, private logs, or other secrets. Redact sensitive values before sharing the report.

## Report

```markdown
## Keiko version

<!-- Enter the installed Keiko version, for example 0.2.6. -->

## Platform

<!-- macOS, Windows, Linux, or other. Include architecture if relevant. -->

## Browser

<!-- Enter the browser and version if the UI is involved, for example Chrome 137. -->

## Summary

<!-- Describe the problem in one or two sentences. -->

## Steps to reproduce

1.
2.
3.

## Expected result

<!-- What should have happened? -->

## Actual result

<!-- What happened instead? Include exact error text if visible. -->

## Evidence

<!-- Add redacted screenshots, console output, or logs if available. -->

## User impact

<!-- Choose one:
- Blocks installation or startup
- Blocks model or credential setup
- Blocks core workflow
- Degrades core workflow
- Visual or usability issue
- Unknown
-->

## Submission safety

- [ ] I have removed secrets, API keys, customer data, private endpoints, and private logs from this report.
```

## Maintainer Handoff

Maintainers should copy the completed report into the tracked [GitHub User-Finding issue form](https://github.com/oscharko-dev/Keiko/issues/new?template=user_finding.yml) and keep the public issue redacted.
