// Runs once around the whole `npm run test:rls` run, on both sides of it.
//
// Before: clears anything an earlier crashed run left in the hosted project,
// so a run never starts on top of someone else's mess.
//
// After: if anything survived, deletes it AND fails the run. A suite's own
// afterAll is still the thing that should have done it — this is the alarm,
// not the cleanup. Without it a run that leaked accounts finished green, which
// is how 41 of them accumulated unnoticed over two days.
//
// Assumes one test run at a time against this project. That was already true —
// it is one developer and one hosted database — and the alternative, an age
// threshold, would let a leak sit around for as long as the threshold.

import { adminClient, deleteTestAccounts, listTestAccounts, loadEnvLocal } from "./rls-test-accounts";

loadEnvLocal();

export async function setup() {
  const admin = adminClient();
  // No credentials: the suites skip themselves, so there is nothing to sweep.
  if (!admin) return;

  const stale = await listTestAccounts(admin);
  if (stale.length === 0) return;

  const { deleted, failed } = await deleteTestAccounts(admin, stale);
  console.warn(
    `[rls] ${stale.length} test account(s) survived an earlier run; deleted ${deleted}.`,
  );
  if (failed.length > 0) {
    console.warn(
      `[rls] could not delete ${failed.length}: ${failed
        .map((f) => `${f.email} (${f.message})`)
        .join("; ")}`,
    );
  }
}

export async function teardown() {
  const admin = adminClient();
  if (!admin) return;

  const leftover = await listTestAccounts(admin);
  if (leftover.length === 0) return;

  const { deleted, failed } = await deleteTestAccounts(admin, leftover);
  const sample = leftover
    .slice(0, 8)
    .map((a) => a.email)
    .join(", ");

  throw new Error(
    `${leftover.length} test account(s) outlived the suite that made them: ${sample}` +
      `${leftover.length > 8 ? `, and ${leftover.length - 8} more` : ""}. ` +
      `Deleted ${deleted} of them just now` +
      `${failed.length > 0 ? `; ${failed.length} would not go: ${failed.map((f) => f.message).join("; ")}` : ""}. ` +
      `The project is clean, but some suite's afterAll did not run or was refused — that is the bug. ` +
      `A suite whose beforeAll throws leaves its users un-promoted and un-deleted, so check for a failed hook above.`,
  );
}
