import { afterEach, describe, expect, it, vi } from "vitest";
import { CoalescingTaskQueue } from "./coalescingTaskQueue";

describe("CoalescingTaskQueue", () => {
  afterEach(() => vi.useRealTimers());

  it("runs at most one task plus one coalesced pending task", async () => {
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const calls: number[] = [];
    const queue = new CoalescingTaskQueue();

    const first = queue.enqueue(async () => {
      calls.push(1);
      await firstBlocked;
    });
    for (let index = 2; index <= 20; index += 1) {
      void queue.enqueue(async () => { calls.push(index); });
    }

    expect(calls).toEqual([1]);
    releaseFirst();
    await first;
    expect(calls).toEqual([1, 20]);
  });

  it("can discard a pending heartbeat while preserving the in-flight task", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const calls: string[] = [];
    const queue = new CoalescingTaskQueue();
    const running = queue.enqueue(async () => { calls.push("running"); await blocked; });
    void queue.enqueue(async () => { calls.push("pending"); });
    queue.discardPending();
    release();
    await running;
    expect(calls).toEqual(["running"]);
  });

  it("bounds waiting for a hanging task and can run again after a failure", async () => {
    vi.useFakeTimers();
    const queue = new CoalescingTaskQueue();
    void queue.enqueue(() => new Promise<void>(() => undefined)).catch(() => undefined);
    const waiting = queue.waitForIdle(500);
    await vi.advanceTimersByTimeAsync(500);
    await expect(waiting).resolves.toBe(false);

    const recoverable = new CoalescingTaskQueue();
    await expect(recoverable.enqueue(async () => { throw new Error("network failed"); })).rejects.toThrow("network failed");
    const completed = vi.fn();
    await recoverable.enqueue(async () => { completed(); });
    expect(completed).toHaveBeenCalledOnce();
  });
});
