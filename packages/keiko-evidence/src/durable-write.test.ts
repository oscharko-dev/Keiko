import { afterEach, describe, expect, it, vi } from "vitest";

interface FsMock {
  readonly closeSync: ReturnType<typeof vi.fn>;
  readonly fsyncSync: ReturnType<typeof vi.fn>;
  readonly openSync: ReturnType<typeof vi.fn>;
  readonly renameSync: ReturnType<typeof vi.fn>;
  readonly rmSync: ReturnType<typeof vi.fn>;
  readonly writeSync: ReturnType<typeof vi.fn>;
}

function createFsMock(): FsMock {
  return {
    closeSync: vi.fn(),
    fsyncSync: vi.fn(),
    openSync: vi.fn(() => 17),
    renameSync: vi.fn(),
    rmSync: vi.fn(),
    writeSync: vi.fn((fd: number, data: Buffer, offset: number, length: number) => {
      expect(fd).toBe(17);
      expect(Buffer.isBuffer(data)).toBe(true);
      expect(offset).toBeGreaterThanOrEqual(0);
      expect(length).toBeGreaterThan(0);
      return length;
    }),
  };
}

async function importDurableWriteWithFs(fs: FsMock): Promise<typeof import("./durable-write.js")> {
  vi.resetModules();
  vi.doMock("node:fs", () => fs);
  return import("./durable-write.js");
}

afterEach(() => {
  vi.doUnmock("node:fs");
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("fsyncDirectoryContaining", () => {
  it("skips the unsupported directory fsync operation on Windows", async () => {
    const fs = createFsMock();
    const { fsyncDirectoryContaining } = await importDurableWriteWithFs(fs);

    fsyncDirectoryContaining("/missing/evidence.json", "win32");

    expect(fs.openSync).not.toHaveBeenCalled();
    expect(fs.fsyncSync).not.toHaveBeenCalled();
    expect(fs.closeSync).not.toHaveBeenCalled();
  });

  it("opens, fsyncs, and closes the containing directory on POSIX platforms", async () => {
    const fs = createFsMock();
    const { fsyncDirectoryContaining } = await importDurableWriteWithFs(fs);

    fsyncDirectoryContaining("/evidence/run.json", "linux");

    expect(fs.openSync).toHaveBeenCalledWith("/evidence", "r");
    expect(fs.fsyncSync).toHaveBeenCalledWith(17);
    expect(fs.closeSync).toHaveBeenCalledWith(17);
  });

  it("still closes the directory descriptor when fsync throws", async () => {
    const error = new Error("fsync failed");
    const fs = createFsMock();
    fs.fsyncSync.mockImplementationOnce(() => {
      throw error;
    });
    const { fsyncDirectoryContaining } = await importDurableWriteWithFs(fs);

    expect(() => {
      fsyncDirectoryContaining("/evidence/run.json", "linux");
    }).toThrow(error);
    expect(fs.closeSync).toHaveBeenCalledWith(17);
  });

  it("does not close an unopened directory descriptor when open throws", async () => {
    const error = new Error("open failed");
    const fs = createFsMock();
    fs.openSync.mockImplementationOnce(() => {
      throw error;
    });
    const { fsyncDirectoryContaining } = await importDurableWriteWithFs(fs);

    expect(() => {
      fsyncDirectoryContaining("/evidence/run.json", "linux");
    }).toThrow(error);
    expect(fs.closeSync).not.toHaveBeenCalled();
  });
});

describe("writeDurableTempFile", () => {
  it("writes string content as UTF-8, fsyncs the file, and closes it", async () => {
    const fs = createFsMock();
    const capturedWrites: Buffer[] = [];
    fs.writeSync.mockImplementationOnce(
      (fd: number, data: Buffer, offset: number, length: number) => {
        expect(fd).toBe(17);
        expect(Buffer.isBuffer(data)).toBe(true);
        expect(offset).toBe(0);
        expect(length).toBe(Buffer.byteLength("Grüße", "utf8"));
        capturedWrites.push(data);
        return length;
      },
    );
    const { writeDurableTempFile } = await importDurableWriteWithFs(fs);

    writeDurableTempFile("/evidence/.run.tmp", "Grüße", 0o640);

    expect(capturedWrites).toHaveLength(1);
    expect(capturedWrites[0]?.toString("utf8")).toBe("Grüße");
    expect(fs.openSync).toHaveBeenCalledWith("/evidence/.run.tmp", "wx", 0o640);
    expect(fs.fsyncSync).toHaveBeenCalledWith(17);
    expect(fs.closeSync).toHaveBeenCalledWith(17);
  });

  it("writes Buffer content without cloning or re-encoding it", async () => {
    const fs = createFsMock();
    const input = Buffer.from([0x00, 0xff, 0x0d, 0x0a]);
    fs.writeSync.mockImplementationOnce(
      (fd: number, data: Buffer, offset: number, length: number) => {
        expect(fd).toBe(17);
        expect(data).toBe(input);
        expect(offset).toBe(0);
        expect(length).toBe(input.length);
        return length;
      },
    );
    const { writeDurableTempFile } = await importDurableWriteWithFs(fs);

    writeDurableTempFile("/evidence/.run.tmp", input);

    expect(fs.fsyncSync).toHaveBeenCalledWith(17);
    expect(fs.closeSync).toHaveBeenCalledWith(17);
  });

  it("continues partial writes with the remaining byte length", async () => {
    const fs = createFsMock();
    const writes: { readonly offset: number; readonly length: number }[] = [];
    fs.writeSync.mockImplementation(
      (_fd: number, _data: Buffer, offset: number, length: number) => {
        writes.push({ offset, length });
        return offset === 0 ? 2 : length;
      },
    );
    const { writeDurableTempFile } = await importDurableWriteWithFs(fs);

    writeDurableTempFile("/evidence/.run.tmp", Buffer.from("abcde"));

    expect(writes).toEqual([
      { offset: 0, length: 5 },
      { offset: 2, length: 3 },
    ]);
  });

  it("closes the file descriptor when file fsync throws", async () => {
    const error = new Error("file fsync failed");
    const fs = createFsMock();
    fs.fsyncSync.mockImplementationOnce(() => {
      throw error;
    });
    const { writeDurableTempFile } = await importDurableWriteWithFs(fs);

    expect(() => {
      writeDurableTempFile("/evidence/.run.tmp", "content");
    }).toThrow(error);
    expect(fs.closeSync).toHaveBeenCalledWith(17);
  });

  it("does not close an unopened file descriptor when open throws", async () => {
    const error = new Error("file open failed");
    const fs = createFsMock();
    fs.openSync.mockImplementationOnce(() => {
      throw error;
    });
    const { writeDurableTempFile } = await importDurableWriteWithFs(fs);

    expect(() => {
      writeDurableTempFile("/evidence/.run.tmp", "content");
    }).toThrow(error);
    expect(fs.writeSync).not.toHaveBeenCalled();
    expect(fs.closeSync).not.toHaveBeenCalled();
  });
});

describe("writeDurableUtf8TempFile", () => {
  it("writes UTF-8 content through the durable temp-file path", async () => {
    const fs = createFsMock();
    const capturedWrites: Buffer[] = [];
    fs.writeSync.mockImplementationOnce(
      (fd: number, data: Buffer, offset: number, length: number) => {
        expect(fd).toBe(17);
        expect(Buffer.isBuffer(data)).toBe(true);
        expect(offset).toBe(0);
        expect(length).toBe(Buffer.byteLength("Grüße", "utf8"));
        capturedWrites.push(data);
        return length;
      },
    );
    const { writeDurableUtf8TempFile } = await importDurableWriteWithFs(fs);

    writeDurableUtf8TempFile("/evidence/.run.tmp", "Grüße", 0o640);

    expect(capturedWrites).toHaveLength(1);
    expect(capturedWrites[0]?.toString("utf8")).toBe("Grüße");
    expect(fs.openSync).toHaveBeenCalledWith("/evidence/.run.tmp", "wx", 0o640);
    expect(fs.fsyncSync).toHaveBeenCalledWith(17);
    expect(fs.closeSync).toHaveBeenCalledWith(17);
  });
});

describe("replaceViaDurableTempFile", () => {
  it("removes the temporary file with force=true when replacement fails", async () => {
    const error = new Error("rename failed");
    const fs = createFsMock();
    fs.renameSync.mockImplementationOnce(() => {
      throw error;
    });
    const { replaceViaDurableTempFile } = await importDurableWriteWithFs(fs);

    expect(() => {
      replaceViaDurableTempFile("/evidence/run.json", "/evidence/.run.tmp", "content");
    }).toThrow(error);
    expect(fs.renameSync).toHaveBeenCalledWith("/evidence/.run.tmp", "/evidence/run.json");
    expect(fs.rmSync).toHaveBeenCalledWith("/evidence/.run.tmp", { force: true });
  });

  // KEIKO-0388 / KEIKO-1034: post-rename fsync failure was misclassified as a pre-rename write
  // failure. The old implementation wrapped writeDurableTempFile + renameSync + fsyncDirectoryContaining
  // in one try/catch, then ran rmSync on a temp path that had already been renamed away — a no-op
  // that hid the real story: content is durably on disk under the target, only the containing-
  // directory fsync failed. Callers wrapped the raw fsync error as "evidence write failed", which
  // is the opposite of what happened.
  //
  // After the fix:
  //   * renameSync is still called (rename succeeded — content is durable on the target)
  //   * the thrown value is a distinct PostRenameFsyncError, not the raw fsync error
  //   * rmSync is NOT called against the temp path (nothing to clean; would have been a no-op)
  //   * the error carries the underlying fsync cause so callers can classify without stringly
  //     matching a message.
  it("surfaces a post-rename dir-fsync failure as a distinct PostRenameFsyncError and does not clean the (already gone) temp", async () => {
    const fsyncError = new Error("dir fsync failed");
    const fs = createFsMock();
    // First fsync is for the temp file inside writeDurableTempFile — that must succeed so the
    // rename actually runs. Second fsync is fsyncDirectoryContaining after the rename — that is
    // the one we make fail.
    fs.fsyncSync.mockImplementationOnce(() => {
      return undefined;
    });
    fs.fsyncSync.mockImplementationOnce(() => {
      throw fsyncError;
    });
    const { replaceViaDurableTempFile, PostRenameFsyncError } = await importDurableWriteWithFs(fs);

    let thrown: unknown;
    try {
      replaceViaDurableTempFile("/evidence/run.json", "/evidence/.run.tmp", "content");
    } catch (error) {
      thrown = error;
    }

    expect(fs.renameSync).toHaveBeenCalledWith("/evidence/.run.tmp", "/evidence/run.json");
    // No rmSync against the (already renamed away) temp path — the durable rename means the
    // temp path no longer exists on disk, so the previous no-op rmSync was pure noise.
    expect(fs.rmSync).not.toHaveBeenCalledWith("/evidence/.run.tmp", { force: true });
    expect(thrown).toBeInstanceOf(PostRenameFsyncError);
    expect(thrown).not.toBe(fsyncError);
    const wrapped = thrown as InstanceType<typeof PostRenameFsyncError>;
    expect(wrapped.cause).toBe(fsyncError);
    expect(wrapped.message).toContain("dir fsync failed");
  });
});
