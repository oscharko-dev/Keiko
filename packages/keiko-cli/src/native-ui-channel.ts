import type { Readable } from "node:stream";

const MAX_RESPONSE_BYTES = 76;

function decodeResponse(bytes: Buffer, kind: number, length: number): Buffer | undefined {
  if (bytes.length < 12) return undefined;
  if (
    bytes.subarray(0, 4).toString("ascii") !== "KRS1" ||
    bytes.readUInt16LE(4) !== 1 ||
    bytes.readUInt16LE(6) !== kind ||
    bytes.readUInt32LE(8) !== length ||
    bytes.length > 12 + length
  )
    throw new Error("native-ui-owner-response-invalid");
  return bytes.length === 12 + length ? bytes.subarray(12) : undefined;
}

export function readNativeUiResponse(
  stream: Readable,
  kind: number,
  length: number,
  deadline: number,
): Promise<Buffer> {
  return new Promise(
    (resolve, reject: Parameters<ConstructorParameters<PromiseConstructor>[0]>[1]) => {
      let bytes = Buffer.alloc(0);
      const cleanup = (): void => {
        clearTimeout(timer);
        stream.off("data", data).off("end", failed).off("close", failed).off("error", failed);
      };
      const failed = (): void => {
        cleanup();
        reject(new Error("native-ui-owner-response-unavailable"));
      };
      const data = (chunk: unknown): void => {
        try {
          if (
            !Buffer.isBuffer(chunk) ||
            bytes.length + chunk.length > MAX_RESPONSE_BYTES ||
            performance.now() >= deadline
          ) {
            failed();
            return;
          }
          bytes = Buffer.concat([bytes, chunk]);
          const result = decodeResponse(bytes, kind, length);
          if (result !== undefined) {
            cleanup();
            if (performance.now() >= deadline)
              reject(new Error("native-ui-owner-response-expired"));
            else resolve(result);
          }
        } catch (error) {
          cleanup();
          if (error instanceof Error) reject(error);
          else reject(new Error("native-ui-owner-response-invalid", { cause: error }));
        }
      };
      const timer = setTimeout(
        failed,
        Math.max(1, Math.min(5000, Math.ceil(deadline - performance.now()))),
      );
      stream.on("data", data).once("end", failed).once("close", failed).once("error", failed);
      if (stream.destroyed || stream.readableEnded || performance.now() >= deadline) failed();
    },
  );
}
