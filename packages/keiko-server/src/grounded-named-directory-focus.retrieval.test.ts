// #4429: a question that names a nested subfolder of the connected folder is answered from that
// subtree. Before the focus pass, the folder name matched no file content strongly enough, the
// keep-one fallback sent one unrelated file and the answer said it had no evidence for the folder.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ConnectedContextPack } from "@oscharko-dev/keiko-contracts/connected-context";
import { runConnectedRetrievalEval } from "./grounded-eval-support.js";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";

const COMMANDS = Array.from({ length: 60 }, (_, index) => `cmd-${String(index).padStart(3, "0")}`);
const TOP_LEVEL = [
  "assistant",
  "bootstrap",
  "bridge",
  "cli",
  "services",
  "tools",
  "utils",
  "hooks",
];
const DOCX_BASE64 =
  "UEsDBBQAAAAIAC28xFzXeYTq8QAAALgBAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbH2QzU7DMBCE730Ky9cqccoBIZSkB36OwKE8wMreJFb9J69b2rdn00KREOVozXwz62nXB+/EHjPZGDq5qhspMOhobBg7+b55ru6koALBgIsBO3lEkut+0W6OCUkwHKiTUynpXinSE3qgOiYMrAwxeyj8zKNKoLcworppmlulYygYSlXmDNkvhGgfcYCdK+LpwMr5loyOpHg4e+e6TkJKzmoorKt9ML+Kqq+SmsmThyabaMkGqa6VzOL1jh/0lSfK1qB4g1xewLNRfcRslIl65xmu/0/649o4DFbjhZ/TUo4aiXh77+qL4sGG71+06jR8/wlQSwMEFAAAAAgALbzEXCAbhuqyAAAALgEAAAsAAABfcmVscy8ucmVsc43Puw6CMBQG4J2naM4uBQdjDIXFmLAafICmPZRGeklbL7y9HRzEODie23fyN93TzOSOIWpnGdRlBQStcFJbxeAynDZ7IDFxK/nsLDJYMELXFs0ZZ57yTZy0jyQjNjKYUvIHSqOY0PBYOo82T0YXDE+5DIp6Lq5cId1W1Y6GTwPagpAVS3rJIPSyBjIsHv/h3ThqgUcnbgZt+vHlayPLPChMDB4uSCrf7TKzQHNKuorZvgBQSwMEFAAAAAgALbzEXGJ/vc/pAAAA5wEAABEAAAB3b3JkL2RvY3VtZW50LnhtbJWRwU7DMAyG73uKKPc13Q4IVU2mgTRxnAQ8QEjNWimxoySs9O1JWtAmDhOc8lv+f/uT0+4+nWVnCHEglHxT1ZwBGuoGPEn++nJY33MWk8ZOW0KQfILId2rVjk1H5sMBJpYnYGxGyfuUfCNEND04HSvygLn3TsHplMtwEiOFzgcyEGNe4KzY1vWdcHpArlaM5alv1E1FzoVf1KKPQZXnOU0W2NictZX8CXQh3XChWrF4LonZn9SR7GCm0k6z6dsy+682XQJ763vNCkh1nfod+Bva9hbaI2EKZOM/4B4g3WIrYjlhUT9fpL4AUEsBAhQDFAAAAAgALbzEXNd5hOrxAAAAuAEAABMAAAAAAAAAAAAAAIABAAAAAFtDb250ZW50X1R5cGVzXS54bWxQSwECFAMUAAAACAAtvMRcIBuG6rIAAAAuAQAACwAAAAAAAAAAAAAAgAEiAQAAX3JlbHMvLnJlbHNQSwECFAMUAAAACAAtvMRcYn+9z+kAAADnAQAAEQAAAAAAAAAAAAAAgAH9AQAAd29yZC9kb2N1bWVudC54bWxQSwUGAAAAAAMAAwC5AAAAFQMAAAAA";

let root = "";

function write(relative: string, content: string | Uint8Array): void {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function materializeCorpus(): void {
  write(
    "commands.ts",
    `${COMMANDS.map((name) => `import ${name.replaceAll("-", "_")} from './commands/${name}/index.js'`).join("\n")}\n`,
  );
  for (const name of COMMANDS) {
    write(
      `commands/${name}/index.ts`,
      `const command = {\n  type: 'local',\n  name: '${name}',\n  description: 'Runs the ${name} workflow',\n} satisfies Command\nexport default command\n`,
    );
    write(
      `commands/${name}/${name}.ts`,
      `export async function call(): Promise<string> {\n  return 'ran ${name}'\n}\n`,
    );
  }
  write(
    "components/PromptInput/PromptInputQueuedCommands.tsx",
    "export function PromptInputQueuedCommands({ commands }: { commands: string[] }) {\n  return commands.filter((command) => command.length > 0)\n}\n",
  );
  write(
    "components/PromptInput/PromptInputFooter.tsx",
    "export function PromptInputFooter() {\n  return 'footer hint'\n}\n",
  );
  for (let index = 0; index < 600; index += 1) {
    const top = TOP_LEVEL[index % TOP_LEVEL.length] ?? "misc";
    write(
      `${top}/module${String(index % 30)}/file${String(index)}.ts`,
      `export function helper${String(index)}(input: string): string {\n  const command = input.trim()\n  return command + '${top}'\n}\n`,
    );
  }
  write(
    "handbook/chapters/operations/guide.docx",
    Uint8Array.from(Buffer.from(DOCX_BASE64, "base64")),
  );
  write("handbook/chapters/operations/notes.md", "# Operations\n\nRestart the bridge nightly.\n");
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "keiko-named-directory-focus-"));
  materializeCorpus();
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

interface Asked {
  readonly pack: ConnectedContextPack;
  readonly sent: readonly string[];
  readonly evidenceDetails: Readonly<Record<string, unknown>> | undefined;
  readonly selection: Readonly<Record<string, unknown>> | undefined;
}

async function ask(query: string): Promise<Asked> {
  const log = createBufferedServerLogSink();
  let sent: readonly string[] = [];
  const { pack } = await runConnectedRetrievalEval({
    root,
    files: {},
    query,
    activityLog: log,
    correlationId: "named-directory-focus",
    answerer: {
      answer: (_question, sentPack) => {
        sent = sentPack.files.map((file) => file.scopePath);
        return Promise.resolve("ok");
      },
    },
  });
  const extraOf = (op: string): Readonly<Record<string, unknown>> | undefined =>
    log.events.find((event) => event.op === op)?.extra;
  return {
    pack,
    sent,
    evidenceDetails: extraOf("search.connected-context.evidence-details"),
    selection: extraOf("search.connected-context.selection-details"),
  };
}

const underCommands = (paths: readonly string[]): readonly string[] =>
  paths.filter((path) => path.startsWith("commands/"));

describe("named subfolder focus over a large nested connected folder (#4429)", () => {
  it("answers a German question about the commands folder from that subtree", async () => {
    const result = await ask("Was machen die Befehle im commands-Ordner?");
    expect(underCommands(result.sent).length).toBeGreaterThanOrEqual(COMMANDS.length);
    expect(result.sent).toContain("commands/cmd-042/index.ts");
    expect(result.selection?.keepOneFallbackApplied).toBe(false);
    expect(result.evidenceDetails).toMatchObject({
      namedDirectoryFocusState: "applied",
      namedDirectoryCount: 1,
      namedDirectoryCandidateFileCount: COMMANDS.length * 2,
      namedDirectoryRetainedFileCount: COMMANDS.length * 2,
      namedDirectoryDocumentCount: 0,
    });
  });

  it("focuses a nested path spelling on exactly that subtree", async () => {
    const result = await ask("What do the files in components/PromptInput do?");
    expect(result.sent).toEqual(
      expect.arrayContaining([
        "components/PromptInput/PromptInputFooter.tsx",
        "components/PromptInput/PromptInputQueuedCommands.tsx",
      ]),
    );
    expect(result.evidenceDetails).toMatchObject({
      namedDirectoryFocusState: "applied",
      namedDirectoryRetainedFileCount: 2,
    });
  });

  it("extracts an office document from a deeply nested named folder", async () => {
    const result = await ask("Was steht im operations-Ordner?");
    expect(result.sent).toEqual(
      expect.arrayContaining([
        "handbook/chapters/operations/guide.docx",
        "handbook/chapters/operations/notes.md",
      ]),
    );
    expect(result.evidenceDetails).toMatchObject({
      namedDirectoryFocusState: "applied",
      namedDirectoryDocumentCount: 1,
    });
  });

  it("records an unknown folder and an uncued question without changing retrieval", async () => {
    const unknown = await ask("What is in the payments folder?");
    expect(unknown.evidenceDetails).toMatchObject({
      namedDirectoryFocusState: "no-match",
      namedDirectoryCount: 0,
    });
    const uncued = await ask("Was machen die Befehle?");
    // An uncued question records nothing: existing evidence lines keep their exact shape.
    expect(uncued.evidenceDetails).toBeDefined();
    expect(uncued.evidenceDetails?.namedDirectoryFocusState).toBeUndefined();
    expect(underCommands(uncued.sent).length).toBeLessThan(COMMANDS.length);
  });
});
