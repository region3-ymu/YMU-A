import { spawnSync } from "node:child_process";
import { createSerwistRoute } from "@serwist/turbopack";

// Precache revision: tie to the current commit so clients pick up new deploys;
// fall back to a random value in environments without git history.
const gitHead = spawnSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf-8",
}).stdout?.trim();
const revision = gitHead || crypto.randomUUID();

export const { dynamic, dynamicParams, revalidate, generateStaticParams, GET } =
  createSerwistRoute({
    additionalPrecacheEntries: [{ url: "/~offline", revision }],
    swSrc: "src/app/sw.ts",
    useNativeEsbuild: true,
  });
