import { describe, expect, it } from "vitest";

import {
  alertQueries,
  ghArguments,
  evaluate,
  main,
  mergeAlerts,
  parseDocumentedAlerts,
  queueFailures,
} from "../check-secret-scanning-queue.mjs";

const DOCUMENT = `## Dispositions

| Alert | Type                 | Location            | Disposition                      |
| ----- | -------------------- | ------------------- | -------------------------------- |
| #20   | provider API key     | \`a.test.ts\`         | False positive — test fixture    |
| #17   | generic (\`password\`) | \`b.md\`              | False positive — doc placeholder |

| Package | Scope | Version | Disposition | Rationale |
| ------- | ----- | ------- | ----------- | --------- |
| \`vitest\` | root | 4.1.11 | current | not an alert row |
`;

const alert = (number, secretType) => ({ number, secret_type: secretType });

describe("check-secret-scanning-queue queries", () => {
  it("always issues the generic secret_type listing alongside the default one", () => {
    // The whole reason this gate exists. GitHub's default listing omits `password`-type findings,
    // so a single unfiltered request cannot see them and would report an empty queue that is not
    // empty. Alert #17 lived undetected for five weeks behind exactly this.
    const [unfiltered, generic] = alertQueries("owner/repo");
    expect(unfiltered).toContain("state=open");
    expect(unfiltered).toContain("hide_secret=true");
    expect(unfiltered).not.toContain("secret_type");
    expect(generic).toContain("secret_type=password");
  });

  it("never requests literal secret values", () => {
    for (const query of alertQueries("owner/repo")) {
      expect(query).toContain("hide_secret=true");
    }
  });
});

describe("check-secret-scanning-queue pagination", () => {
  it("requests every page, because per_page=100 alone truncates the queue silently", () => {
    // A hundred-and-first open alert would be indistinguishable from no alert at all, and this
    // gate would report a clean queue exactly when it is least true.
    const args = ghArguments("repos/o/r/secret-scanning/alerts?state=open");
    expect(args).toContain("--paginate");
    expect(args).toContain("--slurp");
  });
});

describe("check-secret-scanning-queue parsing", () => {
  it("merges the two overlapping listings, counting each alert once", () => {
    expect(
      mergeAlerts([
        [alert(20, "openai_api_key")],
        [alert(17, "password"), alert(20, "openai_api_key")],
      ]),
    ).toEqual([
      { number: 17, secretType: "password" },
      { number: 20, secretType: "openai_api_key" },
    ]);
  });

  it("reads alert rows and ignores tables that are not dispositions", () => {
    expect([...parseDocumentedAlerts(DOCUMENT)].sort((a, b) => a - b)).toEqual([17, 20]);
  });

  it("ignores an alert-shaped number in a table that is not the dispositions table", () => {
    // This document is expected to grow. A later follow-up table listing issue numbers must never
    // be read as a security disposition: a newly opened alert sharing a number with a follow-up
    // would otherwise count as reviewed by nobody.
    const withFollowUps = `${DOCUMENT}

| Ref | Owner | Status | Note |
| --- | ----- | ------ | ---- |
| #31 | infra | open   | unrelated follow-up |
`;
    expect([...parseDocumentedAlerts(withFollowUps)].sort((a, b) => a - b)).toEqual([17, 20]);
  });

  it("ignores a disposition row whose disposition cell is empty", () => {
    const emptied = DOCUMENT.replace("False positive — doc placeholder", "");
    expect([...parseDocumentedAlerts(emptied)]).toEqual([20]);
  });
});

describe("check-secret-scanning-queue rules", () => {
  const documented = new Set([17, 20]);

  it("passes when every open alert has a recorded disposition", () => {
    expect(
      queueFailures(
        [
          { number: 17, secretType: "password" },
          { number: 20, secretType: "openai_api_key" },
        ],
        documented,
      ),
    ).toEqual([]);
  });

  it("fails on an untriaged new alert — the exact #2292 recurrence", () => {
    const failures = queueFailures([{ number: 31, secretType: "password" }], new Set([17, 20]));
    expect(failures).toContain(
      "alert #31 (password) is open and has no recorded disposition in " +
        "docs/release/2296-dependency-security-closeout.md",
    );
  });

  it("fails on a disposition left behind after its alert was closed", () => {
    // A stale disposition is the same defect class as a stale version row: evidence that outlived
    // the fact it described. Removing the row is part of closing the alert.
    const failures = queueFailures([{ number: 17, secretType: "password" }], documented);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("#20");
    expect(failures[0]).toContain("no longer open");
  });
});

describe("check-secret-scanning-queue entry point", () => {
  const seams = (overrides) => ({
    fetchAlerts: () => [[alert(20, "openai_api_key")], [alert(17, "password")]],
    readDocument: () => DOCUMENT,
    ...overrides,
  });

  it("passes on a fully dispositioned queue", () => {
    expect(evaluate(seams({})).openAlerts).toHaveLength(2);
    expect(main(seams({}))).toBe(0);
  });

  it("fails closed when the API request fails, never reading it as an empty queue", () => {
    // An unauthenticated or rate-limited run must not be indistinguishable from "no findings".
    const throwing = seams({
      fetchAlerts: () => {
        throw new Error("GitHub API request failed (exit 1)");
      },
    });
    expect(main(throwing)).toBe(1);
  });

  it("returns a non-zero exit code when an alert is untriaged", () => {
    expect(main(seams({ readDocument: () => "# no dispositions\n" }))).toBe(1);
  });
});
