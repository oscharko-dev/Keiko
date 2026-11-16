import { describe, expect, it } from "vitest";
import {
  checkProperty,
  LINEAR_RATIO_MAX,
  measureScaling,
  propertySettings,
  scalingRatio,
} from "../../../tests/support/property-testing.js";
import { reportDownloadMissing } from "./chat-tool-report-coverage.js";

const REQUEST = "Create a Jira report for download as CSV.";
const FENCE = "```csv\nkey\nSYN-1\n```";

describe("Jira report download fence boundaries", () => {
  it("recognizes localized request forms without confusing examples or negated downloads", async () => {
    await checkProperty({
      name: "localized report download requests",
      runs: 64,
      generate: (random) => ({
        report: random.pick([
          "Bericht",
          "Statusbericht",
          "Abschlussbericht",
          "Übergabebericht",
          "Jira-Bericht",
        ]),
        format: random.pick(["CSV", "Markdown", "Markdown und CSV"]),
        imperative: random.pick(["Lad", "Lade", "Ladet"]),
        action: random.pick(["separated", "export", "plural"]),
      }),
      property: ({ report, format, imperative, action }) => {
        const request =
          action === "separated"
            ? `${imperative} den ${report} für SYN-1 als ${format} herunter.`
            : action === "export"
              ? `Exportiere den ${report} für SYN-1 als ${format}.`
              : `Give me downloadable reports for SYN-1 as ${format}.`;
        expect(reportDownloadMissing([], request, FENCE)).toBe(true);
        expect(reportDownloadMissing([], `Example: ${request}`, FENCE)).toBe(false);
        expect(
          reportDownloadMissing(
            [],
            `${imperative} den ${report} nicht als ${format} herunter.`,
            FENCE,
          ),
        ).toBe(false);
        expect(
          reportDownloadMissing([], request, "The report export is unavailable.\n" + FENCE),
        ).toBe(false);
      },
    });
  });

  it("preserves fenced alternatives and explicit limitations across line endings", async () => {
    const name = "report download fences retain their line boundary";
    const settings = propertySettings({ name });
    let checked = 0;
    await checkProperty({
      name,
      generate: (random) => ({
        lineEnd: random.pick(["\n", "\r\n", "\u2028", "\u2029"]),
        indent: random.pick(["", " ", "\t", "\u00a0"]),
        blanks: random.integer(0, 32),
      }),
      property: ({ lineEnd, indent, blanks }) => {
        const prefix = `Report:${lineEnd}${lineEnd.repeat(blanks)}text${lineEnd}${indent}`;
        expect(reportDownloadMissing([], REQUEST, prefix)).toBe(false);
        expect(reportDownloadMissing([], REQUEST, `${prefix}${FENCE}`)).toBe(true);
        expect(
          reportDownloadMissing(
            [],
            REQUEST,
            `The report export is unavailable.\n${prefix}${FENCE}`,
          ),
        ).toBe(false);
        checked += 1;
      },
    });
    expect(checked).toBe(settings.runs);
  });

  it.each(["", FENCE])("scales linearly across blank lines before %j", (fence) => {
    const scaling = measureScaling({
      size: 256,
      maximumSize: 4096,
      minimumMs: 3,
      build: (size) => `Report:\n${" \n".repeat(size)}text\n${fence}`,
      run: (answer) => reportDownloadMissing([], REQUEST, answer),
    });
    expect(scaling.measurable).toBe(true);
    expect(scalingRatio(scaling)).toBeLessThan(LINEAR_RATIO_MAX);
  });
});
