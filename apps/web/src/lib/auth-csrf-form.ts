"use client";

import { createContext, createElement, useContext, type ReactNode } from "react";

const CsrfContext = createContext<string | null>(null);

/** Request-rendered transport only. Original server actions must verify the token. */
export function CsrfProvider({ token, children }: { token: string | null; children: ReactNode }) {
  return createElement(CsrfContext.Provider, { value: token }, children);
}

export function CsrfField({ token }: { token?: string | null } = {}) {
  const current = useContext(CsrfContext);
  const value = token ?? current;
  return value ? createElement("input", { type: "hidden", name: "_csrf", value }) : null;
}
