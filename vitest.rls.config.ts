import { defineConfig } from "vitest/config";

// Only for `npm run test:rls`. The pure-logic suites under `npm test` need no
// config at all and deliberately do not get this one.
export default defineConfig({
  test: {
    // One suite at a time. These all talk to the same hosted project, and
    // running seventeen of them at once meant a hundred-odd sign-ins hitting
    // the auth API within a couple of seconds. That is very likely what broke
    // the runs of 18 and 21 August 2026: every account they orphaned is still
    // sitting at the role the signup trigger gave it, so each suite died
    // inside its beforeAll, between creating its users and promoting them.
    // (Unprovable now — auth logs keep 24 hours — but the shape fits, and
    // suites that share one database have no business racing each other.)
    fileParallelism: false,
    // Sweep before, and fail loudly after — see tests/rls-global-setup.ts.
    globalSetup: ["tests/rls-global-setup.ts"],
  },
});
