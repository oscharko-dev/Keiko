import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { portableHandoffOperationFrom, readFileDigest } from "./update-portable-handoff-tree.js";

// The file digest reads one chunk per call through `runAsyncSteps`. Written as `return readNext()`
// from an async function, every read would leave a pending outer promise until the last one
// settled, which for a multi-gigabyte artifact is hundreds of thousands live at once, where the loop
// it replaced held constant memory. A handle that answers one byte per read drives fifty thousand
// reads; the digest must equal the one computed over the same bytes in a single pass.
describe("the handoff file digest over many reads", () => {
  it("equals the digest of the same bytes computed in one pass", async () => {
    const total = 50_000;
    const content = Buffer.alloc(total);
    for (let index = 0; index < total; index += 1) content[index] = index % 251;
    let position = 0;
    const handle = {
      read: (buffer: Buffer): Promise<{ bytesRead: number; buffer: Buffer }> => {
        if (position >= total) return Promise.resolve({ bytesRead: 0, buffer });
        buffer[0] = content[position] ?? 0;
        position += 1;
        return Promise.resolve({ bytesRead: 1, buffer });
      },
    };
    const operation = portableHandoffOperationFrom({ deadline: Date.now() + 120_000 });
    const result = await readFileDigest(handle, total, total, operation);
    expect(result.bytes).toBe(total);
    expect(result.digest.equals(createHash("sha256").update(content).digest())).toBe(true);
  }, 120_000);
});
