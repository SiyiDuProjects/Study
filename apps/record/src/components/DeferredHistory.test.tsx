import { useEffect } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DeferredHistory } from "./DeferredHistory";

const loading = vi.hoisted(() => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  return { pending, release, calls: 0, mounts: 0, unmounts: 0 };
});

vi.mock("./RecordHistory", async () => {
  loading.calls += 1;
  await loading.pending;
  return { default: ({ isOpen }: { isOpen: boolean }) => {
    useEffect(() => {
      loading.mounts += 1;
      return () => { loading.unmounts += 1; };
    }, []);
    return isOpen ? <h1>Loaded history</h1> : null;
  } };
});

afterEach(cleanup);

it("does not load on the main screen or reopen after a slow load is cancelled, and retains the loaded component", async () => {
  const props = { isOpen: false, showDocument: false, sessions: [], selectedSession: null, timetable: null, errorMessage: "", onClose: vi.fn(), onBack: vi.fn(), onSelect: vi.fn(), onArchive: vi.fn(), onExport: vi.fn() };
  const view = render(<DeferredHistory {...props} />);
  expect(loading.calls).toBe(0);
  view.rerender(<DeferredHistory {...props} isOpen />);
  await waitFor(() => expect(loading.calls).toBe(1));
  expect(screen.getByText("正在打开课堂记录…")).toBeTruthy();
  view.rerender(<DeferredHistory {...props} />);
  await act(async () => { loading.release(); await loading.pending; });
  expect(screen.queryByText("Loaded history")).toBeNull();
  view.rerender(<DeferredHistory {...props} isOpen />);
  await screen.findByRole("heading", { name: "Loaded history" });
  view.rerender(<DeferredHistory {...props} />);
  expect(loading.calls).toBe(1);
  expect(loading.mounts).toBe(1);
  expect(loading.unmounts).toBe(0);
});
