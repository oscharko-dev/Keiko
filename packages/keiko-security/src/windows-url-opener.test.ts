import { describe, expect, it } from "vitest";
import {
  boundedPowerShellTimeoutMs,
  WINDOWS_PROGRAM_STARTED_MARKER,
} from "./windows-powershell-program.js";
import { resolveWindowsUrlOpener, WINDOWS_URL_OPENER_TIMEOUT_MS } from "./windows-url-opener.js";

const URL = "http://127.0.0.1:1983/#keiko-app-session=%7B%22requestId%22%3A%22r%22%7D";

// A caller-supplied environment whose SystemRoot does not exist resolves the default system root
// lexically, so this suite runs on every platform (windows-system-directory.ts).
const ENV = {};

function programOf(args: readonly string[]): string[] {
  return Buffer.from(args.at(-1) ?? "", "base64")
    .toString("utf16le")
    .split("\n");
}

describe("resolveWindowsUrlOpener", () => {
  it("opens the URL through the identity-resolved inbox PowerShell, never through cmd.exe", () => {
    const opener = resolveWindowsUrlOpener(URL, ENV);
    expect(opener.command.toLowerCase()).toMatch(
      /\\system32\\windowspowershell\\v1\.0\\powershell\.exe$/u,
    );
    expect(opener.args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
    expect(opener.args).toHaveLength(4);
    expect(opener.args.join(" ")).not.toContain(URL);
    expect(programOf(opener.args).at(-1)).toBe(`Start-Process '${URL}'`);
  });

  // #4358: 5 s for PowerShell start AND Start-Process failed whenever the host needed longer.
  it("bounds Start-Process from the program's first statement and the host start separately", () => {
    const opener = resolveWindowsUrlOpener(URL, ENV);
    const program = programOf(opener.args);
    expect(WINDOWS_URL_OPENER_TIMEOUT_MS).toBe(5_000);
    expect(program[0]).toContain(WINDOWS_PROGRAM_STARTED_MARKER);
    expect(program[1]).toBe("$keikoWatchdog = [Threading.CancellationTokenSource]::new(5000)");
    expect(opener.timeoutMs).toBe(boundedPowerShellTimeoutMs(5_000));
    expect(opener.timeoutMs).toBeGreaterThan(20_000);
  });

  it("names a fixed browser executable and passes the URL as its argument", () => {
    const opener = resolveWindowsUrlOpener(URL, ENV, "msedge.exe");
    expect(programOf(opener.args).at(-1)).toBe(`Start-Process 'msedge.exe' -ArgumentList '${URL}'`);
  });

  it("doubles a single quote so a URL cannot leave its PowerShell string", () => {
    const opener = resolveWindowsUrlOpener("http://127.0.0.1:1983/#a'; calc; '", ENV);
    expect(programOf(opener.args).at(-1)).toBe(
      "Start-Process 'http://127.0.0.1:1983/#a''; calc; '''",
    );
  });
});
