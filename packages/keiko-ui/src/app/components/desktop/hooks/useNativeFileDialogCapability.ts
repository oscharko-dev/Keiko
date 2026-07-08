// Epic #1941 — reactive wrapper over the memoized native-dialog capability (ADR-0118 D4).
// Renders `false` until the BFF answers, so Browse buttons start disabled and enable once the
// platform is confirmed; unsupported platforms keep manual path entry as the only input.

import { useEffect, useState } from "react";
import { nativeFileDialogSupported } from "../../../../lib/native-file-dialog";

export function useNativeFileDialogCapability(): boolean {
  const [supported, setSupported] = useState(false);

  useEffect(() => {
    let alive = true;
    void nativeFileDialogSupported().then((value) => {
      if (alive) setSupported(value);
    });
    return () => {
      alive = false;
    };
  }, []);

  return supported;
}
