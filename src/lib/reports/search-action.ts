"use server";

// Thin Server Action wrapper so src/components/search-box.tsx (a client
// component) can call searchAll() directly. Kept separate from search.ts
// itself so that file stays a plain, framework-agnostic async function.

import { requireProfile } from "@/lib/auth/dal";
import { searchAll } from "./search";

export async function searchAllAction(query: string) {
  // Defense-in-depth: every other query/mutation entry point has an explicit
  // server-side identity check. RLS + the proxy already scope results, but an
  // authenticated identity check here keeps this action consistent with the
  // rest of the app and fails closed (redirect to /login) for signed-out callers.
  await requireProfile();
  return searchAll(query);
}
