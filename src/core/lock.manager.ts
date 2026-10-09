export class LockManager {
  private activeLocks = new Map<string, number>();
  readonly lockTimeoutMs = 600000; // 10-minute auto-expiry for stale locks

  // Acquires an exclusive lock on a resource (e.g., projectId)
  acquire(resourceId: string): boolean {
    if (this.isLocked(resourceId)) {
      return false;
    }
    this.activeLocks.set(resourceId, Date.now());
    return true;
  }

  // Releases lock
  release(resourceId: string): void {
    this.activeLocks.delete(resourceId);
  }

  // Checks if resource is locked
  isLocked(resourceId: string): boolean {
    const lockedAt = this.activeLocks.get(resourceId);
    if (!lockedAt) return false;
    if (Date.now() - lockedAt > this.lockTimeoutMs) {
      this.activeLocks.delete(resourceId);
      return false;
    }
    return true;
  }
}

export const lockManager = new LockManager();
