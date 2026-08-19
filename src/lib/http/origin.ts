import { headers } from "next/headers";

/**
 * The origin this request arrived on, for building absolute callback URLs.
 *
 * Derived from the request rather than an env var so the same code produces a
 * working link on localhost, on a preview deployment and in production without
 * anything to configure.
 *
 * Lives here rather than in (auth)/actions.ts because /users needs it too, and
 * that file is "use server" — exporting a helper from a "use server" module
 * turns it into a server action callable from the browser, which is not what a
 * header reader should become.
 */
export async function requestOrigin(): Promise<string> {
  const origin = (await headers()).get("origin");
  return origin ?? "http://localhost:3000";
}
