"use server";

// Thin Server Action wrapper so src/components/search-box.tsx (a client
// component) can call searchAll() directly. Kept separate from search.ts
// itself so that file stays a plain, framework-agnostic async function.

import { searchAll } from "./search";

export async function searchAllAction(query: string) {
  return searchAll(query);
}
