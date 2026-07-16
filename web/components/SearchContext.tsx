"use client";

import { createContext, useContext, useState, type ReactNode } from "react";

interface SearchState {
  query: string;
  setQuery: (q: string) => void;
}

const SearchCtx = createContext<SearchState>({ query: "", setQuery: () => {} });

/** Shares the header search box value with the Discover token list. */
export function SearchProvider({ children }: { children: ReactNode }) {
  const [query, setQuery] = useState("");
  return <SearchCtx.Provider value={{ query, setQuery }}>{children}</SearchCtx.Provider>;
}

export function useSearch() {
  return useContext(SearchCtx);
}
