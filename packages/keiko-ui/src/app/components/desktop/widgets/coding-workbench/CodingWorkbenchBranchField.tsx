"use client";

import { type ReactNode } from "react";
import { useRepositoryBranchState } from "../../hooks/useRepositoryBranchState";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { useCodingWorkbenchTranslate } from "./coding-workbench-i18n";
import styles from "./CodingWorkbenchWindow.module.css";

export function CodingWorkbenchBranchField({
  root,
  value,
  pending,
  onChange,
}: {
  readonly root: string;
  readonly value: string;
  readonly pending: boolean;
  readonly onChange: (value: string) => void;
}): ReactNode {
  const t = useCodingWorkbenchTranslate();
  const branches = useRepositoryBranchState(root.trim() || null);
  const names = branches.branches.map((branch) => branch.name);
  const emptyLabel = branches.loading
    ? "codingWorkbench.setup.branchesLoading"
    : "codingWorkbench.setup.branchesUnavailable";
  const selected = names.includes(value) ? value : "";
  return (
    <>
      <label className={styles.fieldLabel} htmlFor="coding-workbench-setup-branch">
        {t("codingWorkbench.setup.targetBranch")}
      </label>
      <select
        id="coding-workbench-setup-branch"
        className={styles.setupInput}
        value={selected}
        disabled={pending || branches.loading || names.length === 0}
        onChange={(event) => {
          reportClientDiagnostic("[keiko] coding workbench target branch selected");
          onChange(event.target.value);
        }}
      >
        {selected === "" ? <option value="">{t(emptyLabel)}</option> : null}
        {names.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
      <BranchRetry branches={branches} pending={pending} />
    </>
  );
}

function BranchRetry({
  branches,
  pending,
}: {
  readonly branches: ReturnType<typeof useRepositoryBranchState>;
  readonly pending: boolean;
}): ReactNode {
  const t = useCodingWorkbenchTranslate();
  return (
    <>
      {branches.error !== null || (!branches.loading && branches.branches.length === 0) ? (
        <button
          type="button"
          className={styles.button}
          disabled={pending}
          onClick={() => void branches.refresh()}
        >
          {t("codingWorkbench.setup.branchesRetry")}
        </button>
      ) : null}{" "}
    </>
  );
}
