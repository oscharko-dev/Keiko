#!/usr/bin/env node
// Prints a one-time Workbench pairing URL ("url", the default) or the attestation JSON ("json").
// The attestation is valid for about 30 seconds and can be used once; open the URL in a browser
// to pair that browser with the dev server.
import { isMainModule } from "../../lib/is-main-module.mjs";
import {
  UsageError,
  browserBaseUrl,
  labBaseUrl,
  mintPairing,
  parseCli,
  runMain,
} from "./lab-common.mjs";

const USAGE = [
  "usage: node pair.mjs [url|json] [--base-url <origin>]",
  "",
  "Reads the launcher secret from KEIKO_CODING_APP_SESSION_LAUNCHER_SECRET, the value the dev",
  "server was started with. The origin is --base-url, else KEIKO_LAB_BASE_URL, else",
  "http://127.0.0.1:1983 (printed as localhost, the origin the dev server serves pages on).",
].join("\n");

async function main() {
  const cli = parseCli({
    usage: USAGE,
    options: { "base-url": { type: "string" } },
    positionals: true,
  });
  if (cli.help) return;
  const form = cli.positionals[0] ?? "url";
  if (form !== "url" && form !== "json") {
    throw new UsageError(`unknown output form "${form}"; use url or json\n\n${USAGE}`);
  }
  const { attestation, fragment } = await mintPairing();
  const base = browserBaseUrl(labBaseUrl(cli.values["base-url"]));
  console.log(form === "json" ? JSON.stringify(attestation) : `${base}/${fragment}`);
}

if (isMainModule(import.meta.url)) runMain(main);
