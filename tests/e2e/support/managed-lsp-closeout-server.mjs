#!/usr/bin/env node

// Hermetic real-subprocess LSP fixture for Issue #2282. The browser closeout starts this file under
// the governed Python and Go executable names, so the real BFF exercises executable discovery,
// process supervision, initialize negotiation, document synchronization, and JSON-RPC framing.

const RANGE = Object.freeze({
  start: { line: 0, character: 0 },
  end: { line: 0, character: 5 },
});

const CAPABILITIES = Object.freeze({
  textDocumentSync: 2,
  diagnosticProvider: true,
  completionProvider: {},
  hoverProvider: true,
  documentSymbolProvider: true,
  documentFormattingProvider: true,
  definitionProvider: true,
  typeDefinitionProvider: true,
  implementationProvider: true,
  referencesProvider: true,
  callHierarchyProvider: true,
  inlayHintProvider: true,
  renameProvider: { prepareProvider: true },
  codeActionProvider: true,
  signatureHelpProvider: {},
});

let input = Buffer.alloc(0);

function writeFrame(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

function documentUri(message) {
  return message.params?.textDocument?.uri ?? "file:///managed-lsp-closeout";
}

function location(message) {
  return { uri: documentUri(message), range: RANGE };
}

function operationResult(message) {
  const uri = documentUri(message);
  const item = { name: "managedValue", kind: 12, uri, range: RANGE, selectionRange: RANGE };
  const edit = { changes: { [uri]: [{ range: RANGE, newText: "managedValue" }] } };
  const results = {
    "textDocument/diagnostic": {
      kind: "full",
      items: [
        {
          range: RANGE,
          severity: 1,
          code: "M6-2282",
          source: "keiko-e2e",
          message: "Managed diagnostic",
        },
      ],
    },
    "textDocument/completion": [{ label: "managedValue", kind: 3 }],
    "textDocument/hover": { contents: "Managed hover", range: RANGE },
    "textDocument/documentSymbol": [{ name: "managedValue", kind: 12, range: RANGE }],
    "textDocument/formatting": [{ range: RANGE, newText: "managedValue" }],
    "textDocument/definition": [location(message)],
    "textDocument/typeDefinition": [location(message)],
    "textDocument/implementation": [location(message)],
    "textDocument/references": [location(message)],
    "textDocument/prepareCallHierarchy": [item],
    "callHierarchy/incomingCalls": [{ from: item, fromRanges: [RANGE] }],
    "callHierarchy/outgoingCalls": [{ to: item, fromRanges: [RANGE] }],
    "textDocument/inlayHint": [{ position: RANGE.end, label: ": managed", kind: 1 }],
    "textDocument/prepareRename": { range: RANGE, placeholder: "managedValue" },
    "textDocument/rename": edit,
    "textDocument/codeAction": [{ title: "Review managed change", kind: "refactor", edit }],
    "textDocument/signatureHelp": { signatures: [{ label: "managedValue()" }] },
  };
  return results[message.method] ?? null;
}

function handleMessage(message) {
  if (message.method === "exit") {
    process.exit(0);
  }
  if (message.id === undefined) return;
  if (message.method === "initialize") {
    writeFrame({ jsonrpc: "2.0", id: message.id, result: { capabilities: CAPABILITIES } });
    return;
  }
  const result = message.method === "shutdown" ? null : operationResult(message);
  writeFrame({ jsonrpc: "2.0", id: message.id, result });
}

function parseMessage(body) {
  try {
    handleMessage(JSON.parse(body));
  } catch {
    writeFrame({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  }
}

function drainInput() {
  while (input.length > 0) {
    const headerEnd = input.indexOf("\r\n\r\n");
    if (headerEnd === -1) return;
    const header = input.subarray(0, headerEnd).toString("ascii");
    const match = /Content-Length:\s*(\d+)/iu.exec(header);
    if (match === null) {
      input = input.subarray(headerEnd + 4);
      continue;
    }
    const bodyStart = headerEnd + 4;
    const length = Number.parseInt(match[1], 10);
    if (input.length < bodyStart + length) return;
    const body = input.subarray(bodyStart, bodyStart + length).toString("utf8");
    input = input.subarray(bodyStart + length);
    parseMessage(body);
  }
}

process.stdin.on("data", (chunk) => {
  input = Buffer.concat([input, chunk]);
  drainInput();
});
