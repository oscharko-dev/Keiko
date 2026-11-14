import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// #4358 v5: the Windows launcher itself answers a double-click before Node loads. The C source
// cannot be executed here (the Windows behavior is measured on Windows), so this file pins what
// can be pinned from any host: the exact wording of both languages, which this test holds as the
// product text (the CLI's old PowerShell notice carried it before), and the structural promises the
// launcher makes: no console only, shown after two seconds, closed when the child ended, one
// launcher per installation, and no PowerShell in the CLI for the setup notice.

const launcherSource = readFileSync(
  fileURLToPath(
    new URL("../../../native/portable-launcher/keiko-portable-launcher.c", import.meta.url),
  ),
  "utf8",
);

const FEEDBACK_EN =
  "Keiko is being set up. The first start can take several minutes. " +
  "Your browser opens when Keiko is ready.\r\n\r\n" +
  "You can close this message; Keiko keeps starting and your browser opens when it is ready.";

const FEEDBACK_DE =
  "Keiko wird eingerichtet. Der erste Start kann einige Minuten dauern. " +
  "Dein Browser öffnet sich, sobald Keiko bereit ist.\r\n\r\n" +
  "Du kannst diese Meldung schließen; Keiko startet weiter und dein Browser " +
  "öffnet sich, sobald Keiko bereit ist.";

// The macro body: adjacent wide string literals with C escapes for CR, LF and \xNNNN code units.
function decodedFeedbackText(macro: string): string {
  const start = launcherSource.indexOf(`#define ${macro}`);
  if (start < 0) throw new Error(`${macro} is not defined in the launcher source`);
  const lines = launcherSource.slice(start).split("\n");
  const body: string[] = [];
  for (const line of lines) {
    body.push(line);
    if (!line.trimEnd().endsWith("\\")) break;
  }
  const literals = [...body.join("\n").matchAll(/L"((?:[^"\\]|\\.)*)"/gu)].map(
    (part) => part[1] ?? "",
  );
  return literals
    .join("")
    .replaceAll(/\\x([0-9a-fA-F]{4})/gu, (_all, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replaceAll(String.raw`\r`, "\r")
    .replaceAll(String.raw`\n`, "\n");
}

describe("the Windows launcher's own start feedback", () => {
  it("carries the English wording, with the sentence that the message may be closed", () => {
    expect(decodedFeedbackText("KEIKO_FEEDBACK_TEXT_EN")).toBe(FEEDBACK_EN);
  });

  it("carries the German wording in the informal address", () => {
    expect(decodedFeedbackText("KEIKO_FEEDBACK_TEXT_DE")).toBe(FEEDBACK_DE);
  });

  it("chooses the language from the Windows user interface language, no toolkit", () => {
    expect(launcherSource).toMatch(/GetUserDefaultUILanguage\(\)\) == LANG_GERMAN/u);
    expect(launcherSource).toMatch(/L"Keiko", MB_OK \| MB_ICONINFORMATION/u);
  });

  it("shows only a start that is still running after two seconds", () => {
    expect(launcherSource).toMatch(/KEIKO_FEEDBACK_DELAY_MS = 2000/u);
    expect(launcherSource).toMatch(
      /WaitForSingleObject\(feedback->done, KEIKO_FEEDBACK_DELAY_MS\) != WAIT_TIMEOUT\) return 0;/u,
    );
  });

  it("closes the box when the portable launch child has ended and waits on it only boundedly", () => {
    expect(launcherSource).toMatch(/SetEvent\(feedback->done\)/u);
    expect(launcherSource).toMatch(
      /EnumThreadWindows\(feedback->thread_id, close_feedback_window/u,
    );
    expect(launcherSource).toMatch(/PostMessageW\(window, WM_CLOSE, 0, 0\)/u);
    expect(launcherSource).toMatch(
      /WaitForSingleObject\(feedback->thread, KEIKO_FEEDBACK_JOIN_MS\)/u,
    );
  });

  it("starts the feedback before the node --check preflight and only without a console", () => {
    const wrapper = /static int run_with_feedback[\s\S]*?\n\}\n/u.exec(launcherSource)?.[0] ?? "";
    expect(wrapper).toMatch(/!has_console && !claim_launcher_instance/u);
    expect(wrapper).toMatch(/if \(!has_console\) feedback_start\(&feedback\);/u);
    expect(wrapper.indexOf("feedback_start")).toBeLessThan(
      wrapper.indexOf("launch_after_preflight(buffers"),
    );
    const preflight = launcherSource.slice(
      launcherSource.indexOf(
        "static int launch_after_preflight(keiko_launcher_buffers *buffers, int has_console) {",
      ),
    );
    expect(preflight).toMatch(/--check/u);
  });

  it("lets a second start of the same installation bring the first box forward and start nothing", () => {
    expect(launcherSource).toMatch(/Local\\\\KeikoPortableLauncher-%016llx/u);
    expect(launcherSource).toMatch(
      /GetLastError\(\) == ERROR_ALREADY_EXISTS\) \{\s*bring_feedback_forward\(\);/u,
    );
    expect(launcherSource).toMatch(/SetForegroundWindow\(search\.found\)/u);
  });
});

describe("the CLI no longer starts a PowerShell for the setup notice", () => {
  const notifierSource = readFileSync(
    fileURLToPath(new URL("./portable-launch-notifier.ts", import.meta.url)),
    "utf8",
  );

  it("keeps the failure alert as its only Windows box", () => {
    expect(notifierSource).not.toMatch(/setup-notice|SETUP_NOTICE|notifyPortableSetupStarted/u);
    expect(notifierSource).not.toMatch(/'Information'/u);
    expect(notifierSource).toMatch(/'Keiko could not start', 'OK', 'Error'/u);
  });
});
