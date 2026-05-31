"use client";

import { useCallback } from "react";
import { usePathname } from "next/navigation";

export function routeHref(pathname: string, params: URLSearchParams): string {
  const base = pathname === "/launch" ? "/launch" : "/";
  const qs = params.toString();
  return qs.length > 0 ? `${base}?${qs}` : base;
}

export function useWorkspaceRouteHref(): (params: URLSearchParams) => string {
  const pathname = usePathname();
  return useCallback((params: URLSearchParams): string => routeHref(pathname, params), [pathname]);
}
