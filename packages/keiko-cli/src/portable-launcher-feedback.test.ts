import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LAUNCH_FAILURE_REASONS } from "./launch-failure-note.js";

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
      launcherSource.search(/static int launch_after_preflight\([^)]*\) \{/u),
    );
    expect(preflight).toMatch(/--check/u);
  });

  it("lets a second start of the same installation bring the first box forward and start nothing", () => {
    expect(launcherSource).toMatch(/Local\\\\KeikoPortableLauncher-%016llx/u);
    expect(launcherSource).toMatch(
      /GetLastError\(\) == ERROR_ALREADY_EXISTS\) \{\s*if \(!bring_feedback_forward\(\)\)/u,
    );
    expect(launcherSource).toMatch(/SetForegroundWindow\(search\.found\)/u);
    // the claim returns 0 for a second start and run_with_feedback returns before anything starts
    expect(launcherSource).toMatch(
      /if \(!has_console && !claim_launcher_instance\(buffers->root, &instance\)\) return 0;/u,
    );
  });

  // #4358 audit: with no first message showing (not yet shown, closed, or a first launcher that
  // hangs) a second double-click would otherwise be silent. It says so, in the same two languages,
  // before it exits without starting anything.
  it("tells a second start without a visible first box that Keiko is already starting", () => {
    expect(decodedFeedbackText("KEIKO_ALREADY_STARTING_TEXT_EN")).toBe(
      "Keiko is already starting. Your browser opens when it is ready.",
    );
    expect(decodedFeedbackText("KEIKO_ALREADY_STARTING_TEXT_DE")).toBe(
      "Keiko startet bereits. Dein Browser öffnet sich, sobald Keiko bereit ist.",
    );
    const claim =
      /static int claim_launcher_instance[\s\S]*?\n\}\n/u.exec(launcherSource)?.[0] ?? "";
    const forward = claim.indexOf("if (!bring_feedback_forward())");
    const message = claim.indexOf("MessageBoxW(NULL, already_starting_text()");
    const refusal = claim.indexOf("return 0;");
    expect(forward).toBeGreaterThan(-1);
    expect(message).toBeGreaterThan(forward);
    expect(refusal).toBeGreaterThan(message);
  });

  it("bounds the wait for a box that shows late, and says so", () => {
    expect(launcherSource).toMatch(
      /A box whose delay ran out just before this stop[\s\S]*bounded join below \(three seconds\)/u,
    );
    expect(launcherSource).toMatch(/KEIKO_FEEDBACK_JOIN_MS = 3000/u);
  });
});

// #4358 head B: when the `portable launch` child ends non-zero under a double-click, the launcher
// shows the failure box itself, from the closed reason the CLI leaves in a note. What this proves
// from any host: both languages' wording, that every reason the C table names is one the CLI can
// write, and the order of the calls (the note is prepared before the child starts, the box comes
// after the mutex is released, and only for a child that ended non-zero). The behavior is measured
// on Windows.
describe("the Windows launcher's failure box", () => {
  const EXPECTED = {
    KEIKO_FAILURE_GENERIC: [
      "Keiko could not start.\r\n\r\nStart Keiko again. If this happens again, contact support and tell them the time of the start.",
      "Keiko konnte nicht starten.\r\n\r\nStarte Keiko neu. Tritt der Fehler wieder auf, wende dich an den Support und nenne die Uhrzeit des Starts.",
    ],
    KEIKO_FAILURE_HEALTH_TIMEOUT: [
      "Keiko is still starting or took too long to start.\r\n\r\nWait a moment and open Keiko again. If it happens again, contact support and tell them the time of the start.",
      "Keiko startet noch oder hat zu lange gebraucht.\r\n\r\nWarte einen Moment und öffne Keiko erneut. Tritt es wieder auf, wende dich an den Support und nenne die Uhrzeit des Starts.",
    ],
    KEIKO_FAILURE_PORT_IN_USE: [
      "Keiko could not start because its port is already in use.\r\n\r\nClose the other Keiko or program that uses it and start Keiko again.",
      "Keiko konnte nicht starten, weil sein Port schon belegt ist.\r\n\r\nSchließe das andere Keiko oder Programm, das ihn nutzt, und starte Keiko neu.",
    ],
    KEIKO_FAILURE_SETUP_BUSY: [
      "Keiko is already being set up or updated.\r\n\r\nWait until that has finished, then open Keiko again.",
      "Keiko wird gerade eingerichtet oder aktualisiert.\r\n\r\nWarte, bis das fertig ist, und öffne Keiko dann erneut.",
    ],
  } as const;

  it.each(Object.entries(EXPECTED))(
    "carries the %s wording in both languages",
    (name, [en, de]) => {
      expect(decodedFeedbackText(`${name}_EN`)).toBe(en);
      expect(decodedFeedbackText(`${name}_DE`)).toBe(de);
    },
  );

  it("names only reasons the CLI can write, and reads only a closed token from the note", () => {
    const table = /KEIKO_FAILURE_TEXTS\[\] = \{([\s\S]*?)\n\};/u.exec(launcherSource)?.[1] ?? "";
    const tokens = [...table.matchAll(/\{"([a-z-]+)",/gu)].map((match) => match[1]);
    expect(tokens).toEqual(["health-timeout", "port-in-use", "setup-busy"]);
    for (const token of tokens) {
      expect(LAUNCH_FAILURE_REASONS).toContain(token);
    }
    // the file's own text is never shown: only lowercase letters and hyphens are taken as a token
    expect(launcherSource).toMatch(/text\[index\] >= 'a' && text\[index\] <= 'z'/u);
    expect(launcherSource).toMatch(/L"KEIKO_PORTABLE_FAILURE_NOTE"/u);
    expect(launcherSource).toMatch(/keiko-launch-note-%lu\.txt/u);
  });

  it("prepares the note before the child starts and shows the box after the mutex is released", () => {
    const preflight = launcherSource.slice(
      launcherSource.search(/static int launch_after_preflight\([^)]*\) \{/u),
    );
    expect(preflight.indexOf("prepare_failure_note(buffers)")).toBeGreaterThan(-1);
    expect(preflight.indexOf("prepare_failure_note(buffers)")).toBeLessThan(
      preflight.indexOf("CreateProcessW("),
    );
    expect(preflight).toMatch(/\*child_ended = 1;\s*return \(int\)exit_code;/u);

    const wrapper = /static int run_with_feedback[\s\S]*?\n\}\n/u.exec(launcherSource)?.[0] ?? "";
    expect(wrapper.indexOf("CloseHandle(instance)")).toBeGreaterThan(-1);
    expect(wrapper.indexOf("CloseHandle(instance)")).toBeLessThan(
      wrapper.indexOf("show_failure_box(buffers)"),
    );
    expect(wrapper).toMatch(/if \(!has_console && child_ended && result != 0\) show_failure_box/u);
    // the box follows the stop of the first-start message: they are never shown together
    expect(wrapper.indexOf("feedback_stop(&feedback)")).toBeLessThan(
      wrapper.indexOf("show_failure_box(buffers)"),
    );
  });

  it("shows the box as an error with the product title and removes the note it read", () => {
    expect(launcherSource).toMatch(
      /MessageBoxW\(NULL, failure_text\(reason\), L"Keiko", MB_OK \| MB_ICONERROR\)/u,
    );
    expect(launcherSource).toMatch(/\(void\)DeleteFileW\(path\);/u);
  });
});

describe("the CLI starts no notifier process of its own on Windows", () => {
  const notifierSource = readFileSync(
    fileURLToPath(new URL("./portable-launch-notifier.ts", import.meta.url)),
    "utf8",
  );

  it("has no PowerShell box, neither a setup notice nor a failure alert", () => {
    expect(notifierSource).not.toMatch(/setup-notice|SETUP_NOTICE|notifyPortableSetupStarted/u);
    expect(notifierSource).not.toMatch(/PresentationFramework|MessageBox|Start-Process|-Command/u);
    expect(notifierSource).not.toMatch(/windows-helper-start/u);
  });
});
