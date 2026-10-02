import { afterEach, describe, expect, it, vi } from "vitest";

class TestElement {
  textContent = "";
  href = "";
  dataset: Record<string, string> = {};
  children: TestElement[] = [];
  setAttribute() {}
  replaceChildren() { this.children = []; }
  append(...elements: TestElement[]) { this.children.push(...elements); }
}

afterEach(() => vi.unstubAllGlobals());

async function renderRecordings(payload: unknown) {
  const status = new TestElement();
  const list = new TestElement();
  vi.stubGlobal("document", {
    body: { dataset: { page: "test" } },
    querySelector: (selector: string) => selector === "#recordings-status" ? status : selector === "#recordings-list" ? list : null,
    createElement: () => new TestElement(),
  });
  const fetch = vi.fn(async () => new Response(JSON.stringify(payload), {
    headers: { "content-type": "application/json" },
  }));
  vi.stubGlobal("fetch", fetch);
  const { loadRecordings } = await import("../src/web/assets/auth.js");
  await loadRecordings();
  expect(fetch).toHaveBeenCalledWith("/api/lecture/sessions", expect.objectContaining({ method: "GET", credentials: "same-origin" }));
  return { status, list };
}

describe("account recordings display", () => {
  it("renders the paged items contract and keeps continuation and incomplete-record warnings visible", async () => {
    const { list, status } = await renderRecordings({
      items: [{ id: "recording-1", title: "第一周课堂", courseName: "韩语", status: "ready", segmentCount: 3, finalizationWarning: "Last segment incomplete" }],
      nextCursor: "next-page",
      warnings: [{ code: "invalid_record", recordId: "recording-2", message: "Skipped invalid record" }],
    });
    expect(list.children).toHaveLength(1);
    expect(list.children[0]?.children[0]).toMatchObject({
      href: "https://lecture.siyidu.com/?session=recording-1",
      textContent: "第一周课堂",
    });
    expect(list.children[0]?.children[1]?.textContent).toContain("文稿可能不完整");
    expect(status.textContent).toContain("最近 1 条记录");
    expect(status.textContent).toContain("更多记录");
    expect(status.textContent).toContain("部分记录暂无法读取");
  });

  it("does not call an empty partial page an empty archive", async () => {
    const { status } = await renderRecordings({ items: [], nextCursor: "next-page", warnings: [] });
    expect(status.textContent).toContain("继续查看");
    expect(status.textContent).not.toContain("还没有保存");
  });

  it("reports no saved recordings only for a complete empty result", async () => {
    const { status, list } = await renderRecordings({ items: [], nextCursor: null, warnings: [] });
    expect(list.children).toHaveLength(0);
    expect(status.textContent).toBe("还没有保存的课堂记录。");
  });

  it("shows a read failure instead of treating a mismatched API contract as no recordings", async () => {
    const { status } = await renderRecordings({ sessions: [{ id: "old-shape" }] });
    expect(status.dataset.kind).toBe("error");
    expect(status.textContent).toContain("暂时无法读取");
    expect(status.textContent).not.toContain("还没有保存");
  });
});
