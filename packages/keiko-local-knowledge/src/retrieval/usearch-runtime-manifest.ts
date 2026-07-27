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
      binarySha256: "3ec1cc10dd85b0ec4d40808dab3c6eda1e8abf6c6297611609dd1d2c4670d98a",
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
});

export type UsearchRuntimeTargetKey = keyof typeof USEARCH_RUNTIME_MANIFEST.targets;

export function usearchRuntimeTargetKey(
  platform: NodeJS.Platform,
  architecture: string,
): UsearchRuntimeTargetKey | undefined {
  const key = `${platform}-${architecture}`;
  return key in USEARCH_RUNTIME_MANIFEST.targets ? (key as UsearchRuntimeTargetKey) : undefined;
}
