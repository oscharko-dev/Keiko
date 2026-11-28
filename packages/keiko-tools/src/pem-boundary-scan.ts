// Private-key block tracking for the head/tail output retention of `runCommand` (ADR-0006 D5).
// The retention discards the middle of an output, so a key whose BEGIN line was dropped leaves a
// base64 body at the start of the retained tail with no boundary the redactor could recognize.
// This scanner follows the stream incrementally (constant memory, linear time) and tells the
// retention whether a block is open where it cuts, so the key body is withheld, never disclosed.
// The boundary grammar is the one `redact` uses (keiko-security redaction-private-key).

const BOUNDARY = /-----(BEGIN|END) [A-Z ]*PRIVATE KEY-----/gu;
const END_BOUNDARY = /-----END [A-Z ]*PRIVATE KEY-----/u;
const DASHES = "-----";
const MARKER_WORDS = ["BEGIN", "END"] as const;
// The rest of a marker after its word while it can still grow into ` [A-Z ]*PRIVATE KEY-----`.
const MARKER_LABEL_PREFIX = /^(?: [A-Z ]*-{0,4})?$/u;
// The carry bounds the memory of the scan: a pending marker prefix longer than this is a hostile
// label, and the scan fails closed by treating a block as open.
const PENDING_CAP_CHARS = 4_096;
// Partial leading dashes of a marker that a feed may end in.
const PARTIAL_DASH_CHARS = 4;
const DASH = 0x2d;
const NEWLINE = 0x0a;

export interface PemScan {
  // A BEGIN boundary was seen and no END has followed it yet.
  open: boolean;
  carry: string;
}

export function newPemScan(): PemScan {
  return { open: false, carry: "" };
}

// Feeds the next bytes of the stream. A boundary split across two feeds is found through `carry`.
// A boundary ends in a dash, so bytes without one cannot complete a boundary.
export function feedPemScan(scan: PemScan, bytes: Buffer): void {
  if (bytes.length === 0) return;
  const text = scan.carry + bytes.toString("latin1");
  if (bytes.includes(DASH)) {
    const seen = scan.carry.length;
    for (const match of text.matchAll(BOUNDARY)) {
      if (match.index + match[0].length > seen) scan.open = match[1] === "BEGIN";
    }
  }
  const pendingAt = text.lastIndexOf(DASHES);
  const pending = pendingAt < 0 ? "" : text.slice(pendingAt);
  if (!isMarkerPrefix(pending)) {
    scan.carry = text.slice(-PARTIAL_DASH_CHARS);
  } else if (pending.length > PENDING_CAP_CHARS) {
    scan.open = true;
    scan.carry = text.slice(-PARTIAL_DASH_CHARS);
  } else {
    scan.carry = pending;
  }
}

// The retained head up to the line that opened a block that never closed within it.
export function withholdOpenKeyHead(head: Buffer): Buffer {
  const text = head.toString("latin1");
  let openAt: number | undefined;
  for (const match of text.matchAll(BOUNDARY)) {
    if (match[1] === "BEGIN") openAt ??= match.index;
    else openAt = undefined;
  }
  if (openAt === undefined) return head;
  return head.subarray(0, text.lastIndexOf("\n", openAt - 1) + 1);
}

// The retained tail after the line that ends the block open at its start; empty when no END line
// (or no complete END line) arrives, so an unprovable boundary withholds rather than discloses.
export function withholdOpenKeyTail(tail: Buffer): Buffer {
  const text = tail.toString("latin1");
  const end = END_BOUNDARY.exec(text);
  if (end === null) return Buffer.alloc(0);
  const newline = tail.indexOf(NEWLINE, end.index + end[0].length);
  return newline < 0 ? Buffer.alloc(0) : tail.subarray(newline + 1);
}

// What a boundary marker can still become: the text from its leading dashes while it remains a
// possible prefix of `-----(BEGIN|END) [A-Z ]*PRIVATE KEY-----` (the label is unbounded in the grammar).
function isMarkerPrefix(text: string): boolean {
  if (!text.startsWith(DASHES)) return false;
  const rest = text.slice(DASHES.length);
  const word = MARKER_WORDS.find((candidate) => rest.startsWith(candidate));
  if (word === undefined) return MARKER_WORDS.some((candidate) => candidate.startsWith(rest));
  return MARKER_LABEL_PREFIX.test(rest.slice(word.length));
}
