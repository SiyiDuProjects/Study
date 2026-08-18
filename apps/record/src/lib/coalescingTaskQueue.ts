export class CoalescingTaskQueue {
  private pendingTask: (() => Promise<void>) | null = null;
  private running: Promise<void> | null = null;

  enqueue(task: () => Promise<void>): Promise<void> {
    this.pendingTask = task;
    if (!this.running) {
      const wrapped = this.drain().finally(() => {
        if (this.running === wrapped) this.running = null;
      });
      this.running = wrapped;
    }
    return this.running;
  }

  async waitForIdle(timeoutMs: number): Promise<boolean> {
    const running = this.running;
    if (!running) return true;
    let timer: number | undefined;
    try {
      return await Promise.race([
        running.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = window.setTimeout(() => resolve(false), timeoutMs);
        })
      ]);
    } finally {
      if (timer !== undefined) window.clearTimeout(timer);
    }
  }

  discardPending(): void {
    this.pendingTask = null;
  }

  private async drain(): Promise<void> {
    try {
      while (this.pendingTask) {
        const task = this.pendingTask;
        this.pendingTask = null;
        await task();
      }
    } finally {
      this.pendingTask = null;
    }
  }
}
