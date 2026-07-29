import { withFileLock } from "../storage/locks";
import { refreshLabActivity, type Clock, type StateRoots } from "../storage/state";

export function activityNow(clock: Clock): Date {
  const value = clock();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("clock returned an invalid date");
  return value;
}

export async function refreshLockedLabActivity(
  roots: StateRoots,
  owner: string,
  labId: string,
  labLock: string,
  clock: Clock,
): Promise<void> {
  await withFileLock(labLock, async () => {
    await refreshLabActivityState(roots, owner, labId, clock);
  }, { attempts: 600, delayMs: 50 });
}

export async function refreshLabActivityState(roots: StateRoots, owner: string, labId: string, clock: Clock): Promise<void> {
  await refreshLabActivity(roots, owner, labId, clock);
}

export async function withActivityLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  return await withFileLock(path, operation, { attempts: 600, delayMs: 50 });
}
