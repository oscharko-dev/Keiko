interface UsearchRuntimeSourceApproval {
  readonly version: string;
  readonly sourceCommit: string;
  readonly tarballUrl: string;
  readonly tarballSha256: string;
  readonly licenseSha256: string;
}

interface UsearchRuntimeTargetApproval {
  readonly archivePath: string;
  readonly binarySha256: string;
  readonly source?: Readonly<Partial<UsearchRuntimeSourceApproval>>;
}

interface UsearchRuntimeManifest extends UsearchRuntimeSourceApproval {
  readonly targets: Readonly<Record<string, Readonly<UsearchRuntimeTargetApproval>>>;
}

export const USEARCH_RUNTIME_MANIFEST = Object.freeze({
  version: "2.26.0",
  sourceCommit: "d92b5495b8451946c9d3e81d0b2d5cf9104579f8",
  tarballUrl: "https://registry.npmjs.org/usearch/-/usearch-2.26.0.tgz",
  tarballSha256: "30ea2585723dfa1a4868657a82e33a6497c02551db0403ec9338cb97066d0f72",
  licenseSha256: "c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4",
  targets: Object.freeze({
    "darwin-arm64": Object.freeze({
      archivePath: "package/prebuilds/darwin-arm64+x64/usearch.node",
      binarySha256: "3ec1cc10dd85b0ec4d40808dab3c6eda1e8abf6c6297611609dd1d2c4670d98a",
    }),
    "darwin-x64": Object.freeze({
      archivePath: "package/prebuilds/darwin-arm64+x64/usearch.node",
      binarySha256: "c006e4774917d8bc1efc0382e7f31dcdb08c1f625091dbe7eeafd43ae7a660e6",
      source: Object.freeze({
        version: "2.21.4",
        sourceCommit: "a2f17599101729d667dc0260dd278852d9098183",
        tarballUrl: "https://registry.npmjs.org/usearch/-/usearch-2.21.4.tgz",
        tarballSha256: "f04ffee2386bb21d2ba3841d7ce3203530138772f408e9de767cb249fe5ccfda",
      }),
    }),
    "linux-arm64": Object.freeze({
      archivePath: "package/prebuilds/linux-arm64/usearch.node",
      binarySha256: "fbb272981cf28425091205a80cb976c4caeee647a5e4e15f505d646d9184c517",
    }),
    "linux-x64": Object.freeze({
      archivePath: "package/prebuilds/linux-x64/usearch.node",
      binarySha256: "cf0e422433d03c8f7f9a1f1d58f369b9dd0d29a9549cd6e3fe87973a29ef6637",
    }),
    "win32-x64": Object.freeze({
      archivePath: "package/prebuilds/win32-x64/usearch.node",
      binarySha256: "bd470f8543e99b4260f75f325bf2ae8c92b367d513630db3e35dcfdb2b25a9af",
    }),
  }),
}) satisfies Readonly<UsearchRuntimeManifest>;

export type UsearchRuntimeTargetKey = keyof typeof USEARCH_RUNTIME_MANIFEST.targets;

export function usearchRuntimeTargetKey(
  platform: NodeJS.Platform,
  architecture: string,
): UsearchRuntimeTargetKey | undefined {
  const key = `${platform}-${architecture}`;
  return key in USEARCH_RUNTIME_MANIFEST.targets ? (key as UsearchRuntimeTargetKey) : undefined;
}

export interface UsearchRuntimeApproval extends UsearchRuntimeSourceApproval {
  readonly archivePath: string;
  readonly binarySha256: string;
}

export function usearchRuntimeApproval(
  targetKey: string | undefined,
  runtimeManifest: Readonly<UsearchRuntimeManifest> = USEARCH_RUNTIME_MANIFEST,
): Readonly<UsearchRuntimeApproval> | undefined {
  if (targetKey === undefined) return undefined;
  const target = runtimeManifest.targets[targetKey];
  if (target === undefined) return undefined;
  const source = { ...runtimeManifest, ...target.source };
  return Object.freeze({
    version: source.version,
    sourceCommit: source.sourceCommit,
    tarballUrl: source.tarballUrl,
    tarballSha256: source.tarballSha256,
    licenseSha256: source.licenseSha256,
    archivePath: target.archivePath,
    binarySha256: target.binarySha256,
  });
}
