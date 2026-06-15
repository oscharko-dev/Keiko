import type { ReactNode } from "react";
import { redirect } from "next/navigation";

export const metadata = {
  title: "Keiko",
};

export default function MemoryConsolidationPage(): ReactNode {
  redirect("/");
}
