export interface RollbackTask {
  id: string;
  sessionId: string;
  originalCommand: string;
  executedCommand: string;
  inverseCommand: string;
  description: string;
  createdAt: number;
  expiresAt: number;
}

export interface PendingRollback {
  sessionId: string;
  task: RollbackTask;
  requestedIndex: number;
  requestedAt: number;
}

export class RollbackService {
  private static readonly DEFAULT_TTL_MS = 30 * 60 * 1000;
  private static readonly MAX_HISTORY_PER_SESSION = 20;
  private readonly history = new Map<string, RollbackTask[]>();
  private readonly pendingConfirmations = new Map<string, PendingRollback>();

  record(task: Omit<RollbackTask, "id" | "createdAt" | "expiresAt">): RollbackTask {
    this.purgeExpired(task.sessionId);
    const created: RollbackTask = {
      ...task,
      id: `rb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: Date.now(),
      expiresAt: Date.now() + RollbackService.DEFAULT_TTL_MS
    };
    const list = this.history.get(task.sessionId) ?? [];
    list.push(created);
    if (list.length > RollbackService.MAX_HISTORY_PER_SESSION) {
      list.splice(0, list.length - RollbackService.MAX_HISTORY_PER_SESSION);
    }
    this.history.set(task.sessionId, list);
    return created;
  }

  popLast(sessionId: string): RollbackTask | undefined {
    this.purgeExpired(sessionId);
    const list = this.history.get(sessionId);
    if (!list?.length) return undefined;
    const task = list.pop();
    if (!list.length) this.history.delete(sessionId);
    return task;
  }

  popByReverseIndex(sessionId: string, reverseIndex: number): RollbackTask | undefined {
    this.purgeExpired(sessionId);
    const list = this.history.get(sessionId);
    if (!list?.length || reverseIndex < 1 || reverseIndex > list.length) return undefined;
    const arrayIndex = list.length - reverseIndex;
    const [task] = list.splice(arrayIndex, 1);
    if (!list.length) this.history.delete(sessionId);
    return task;
  }

  requestRollback(sessionId: string, reverseIndex?: number): PendingRollback | undefined {
    const requestedIndex = reverseIndex && reverseIndex > 1 ? reverseIndex : 1;
    const task = this.peekByReverseIndex(sessionId, requestedIndex);
    if (!task) return undefined;
    const pending: PendingRollback = { sessionId, task, requestedIndex, requestedAt: Date.now() };
    this.pendingConfirmations.set(sessionId, pending);
    return pending;
  }

  getPendingRollback(sessionId: string): PendingRollback | undefined {
    return this.pendingConfirmations.get(sessionId);
  }

  confirmPendingRollback(sessionId: string): PendingRollback | undefined {
    const pending = this.pendingConfirmations.get(sessionId);
    if (!pending) return undefined;
    this.purgeExpired(sessionId);
    const removed = this.removeById(sessionId, pending.task.id);
    this.pendingConfirmations.delete(sessionId);
    if (!removed) {
      return undefined;
    }
    pending.task = removed;
    return pending;
  }

  cancelPendingRollback(sessionId: string): PendingRollback | undefined {
    const pending = this.pendingConfirmations.get(sessionId);
    if (!pending) return undefined;
    this.pendingConfirmations.delete(sessionId);
    return pending;
  }

  peekLast(sessionId: string): RollbackTask | undefined {
    this.purgeExpired(sessionId);
    const list = this.history.get(sessionId);
    if (!list?.length) return undefined;
    return list[list.length - 1];
  }

  list(sessionId: string): RollbackTask[] {
    this.purgeExpired(sessionId);
    return [...(this.history.get(sessionId) ?? [])].reverse();
  }

  getTtlMs(task: RollbackTask): number {
    return Math.max(0, task.expiresAt - Date.now());
  }

  private peekByReverseIndex(sessionId: string, reverseIndex: number): RollbackTask | undefined {
    this.purgeExpired(sessionId);
    const list = this.history.get(sessionId);
    if (!list?.length || reverseIndex < 1 || reverseIndex > list.length) {
      return undefined;
    }
    const arrayIndex = list.length - reverseIndex;
    return list[arrayIndex];
  }

  private purgeExpired(sessionId: string): void {
    const list = this.history.get(sessionId);
    if (!list?.length) return;
    const now = Date.now();
    const kept = list.filter((task) => task.expiresAt > now);
    if (!kept.length) {
      this.history.delete(sessionId);
      return;
    }
    this.history.set(sessionId, kept);
  }

  private removeById(sessionId: string, taskId: string): RollbackTask | undefined {
    const list = this.history.get(sessionId);
    if (!list?.length) {
      return undefined;
    }
    const idx = list.findIndex((item) => item.id === taskId);
    if (idx < 0) {
      return undefined;
    }
    const [task] = list.splice(idx, 1);
    if (!list.length) {
      this.history.delete(sessionId);
    } else {
      this.history.set(sessionId, list);
    }
    return task;
  }
}
