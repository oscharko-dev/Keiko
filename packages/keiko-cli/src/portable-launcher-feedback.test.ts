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
    expect(launcherSource).toMatch(/show_box\(feedback_text\(\), MB_ICONINFORMATION\)/u);
    expect(launcherSource).toMatch(/MessageBoxW\(NULL, text, L"Keiko", MB_OK \| icon\)/u);
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
    const message = claim.indexOf("show_box(already_starting_text(), MB_ICONINFORMATION)");
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
    KEIKO_FAILURE_LIFECYCLE_BUSY: [
      "Keiko is just being started, stopped or updated.\r\n\r\nWait a moment and open Keiko again.",
      "Keiko wird gerade gestartet, beendet oder aktualisiert.\r\n\r\nWarte einen Moment und öffne Keiko erneut.",
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
    expect(tokens).toEqual(["health-timeout", "port-in-use", "setup-busy", "lifecycle-busy"]);
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
    expect(wrapper).toMatch(
      /if \(!has_console && child_ended && result != 0 &&\s*\(DWORD\)result != KEIKO_STATUS_CONTROL_C_EXIT\) \{\s*show_failure_box\(buffers\);/u,
    );
    // the box follows the stop of the first-start message: they are never shown together
    expect(wrapper.indexOf("feedback_stop(&feedback)")).toBeLessThan(
      wrapper.indexOf("show_failure_box(buffers)"),
    );
  });

  it("shows the box as an error with the product title and removes the note it read", () => {
    expect(launcherSource).toMatch(/show_box\(failure_text\(reason\), MB_ICONERROR\)/u);
    expect(launcherSource).toMatch(/\(void\)DeleteFileW\(path\);/u);
  });
});

// #4358 head C: a start without a console and without a visible desktop (a scheduled task, a service,
// an automation step) has nobody to close a box, so a box there would block for ever and the exit
// code would never be returned. Every box goes through one function that asks for an interactive,
// visible window station first; the update coordinator branches of wmain never reach a box.
describe("the Windows launcher's boxes need a visible desktop", () => {
  it("has exactly one MessageBoxW, inside show_box, after the desktop check", () => {
    expect(launcherSource.match(/MessageBoxW\(/gu)).toHaveLength(1);
    const showBox =
      /static void show_box\([^)]*\) \{[\s\S]*?\n\}\n/u.exec(launcherSource)?.[0] ?? "";
    expect(showBox).toMatch(/if \(!desktop_is_interactive\(\)\) return;/u);
    expect(showBox.indexOf("desktop_is_interactive")).toBeLessThan(showBox.indexOf("MessageBoxW"));
  });

  it("asks for a visible window station and for a session that is not shutting down", () => {
    const check =
      /static int desktop_is_interactive\(void\) \{[\s\S]*?\n\}\n/u.exec(launcherSource)?.[0] ?? "";
    expect(check).toMatch(/GetProcessWindowStation\(\)/u);
    expect(check).toMatch(/GetUserObjectInformationW\(station, UOI_FLAGS/u);
    expect(check).toMatch(/WSF_VISIBLE/u);
    expect(check).toMatch(/GetSystemMetrics\(SM_SHUTTINGDOWN\) == 0/u);
    // an unreadable window station is not a visible one
    expect(check).toMatch(/GetUserObjectInformationW[\s\S]*?\{\s*return 0;/u);
  });

  it("starts no first-start thread without a desktop, and every box call site uses show_box", () => {
    const start =
      /static void feedback_start\([^)]*\) \{[\s\S]*?\n\}\n/u.exec(launcherSource)?.[0] ?? "";
    expect(start).toMatch(/if \(!desktop_is_interactive\(\)\) return;/u);
    for (const site of [
      /show_box\(feedback_text\(\), MB_ICONINFORMATION\)/u,
      /show_box\(already_starting_text\(\), MB_ICONINFORMATION\)/u,
      /show_box\(failure_text\(reason\), MB_ICONERROR\)/u,
      /show_box\(dialog_text, MB_ICONERROR\)/u,
    ]) {
      expect(launcherSource).toMatch(site);
    }
  });

  it("returns the exit code at once when no box is shown: the note is read before the check", () => {
    const failure =
      /static void show_failure_box\([^)]*\) \{[\s\S]*?\n\}\n/u.exec(launcherSource)?.[0] ?? "";
    // read (and removed) first, so no file is left behind where nothing could be shown
    expect(failure.indexOf("read_failure_reason")).toBeLessThan(failure.indexOf("show_box"));
  });

  it("never reaches a box from the update coordinator branches of wmain", () => {
    const main = launcherSource.slice(launcherSource.indexOf("int wmain("));
    const beforeDefault = main.slice(0, main.lastIndexOf("run_launcher"));
    expect(beforeDefault).toMatch(/--coordinate-update/u);
    expect(beforeDefault).toMatch(/--recover-update/u);
    expect(beforeDefault).not.toMatch(/show_box|show_failure_box|run_with_feedback|MessageBoxW/u);
  });

  // A child ended on purpose must not read as a failed start: a logoff or Ctrl+C ends a console child
  // with STATUS_CONTROL_C_EXIT, and a session that is shutting down shows nothing (above).
  it("shows no failure box for a child ended by Ctrl+C or a logoff", () => {
    expect(launcherSource).toMatch(/KEIKO_STATUS_CONTROL_C_EXIT 0xC000013AUL/u);
    expect(launcherSource).toMatch(
      /result != 0 &&\s*\(DWORD\)result != KEIKO_STATUS_CONTROL_C_EXIT/u,
    );
  });

  it("clears an externally set note variable before the launcher names its own", () => {
    const prepare =
      /static void prepare_failure_note\([^)]*\) \{[\s\S]*?\n\}\n/u.exec(launcherSource)?.[0] ?? "";
    expect(
      prepare.indexOf('SetEnvironmentVariableW(L"KEIKO_PORTABLE_FAILURE_NOTE", NULL)'),
    ).toBeGreaterThan(-1);
    expect(
      prepare.indexOf('SetEnvironmentVariableW(L"KEIKO_PORTABLE_FAILURE_NOTE", NULL)'),
    ).toBeLessThan(prepare.indexOf("GetTempPathW"));
    expect(prepare).toMatch(/length >= \(DWORD\)KEIKO_NOTE_CAP/u);
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
