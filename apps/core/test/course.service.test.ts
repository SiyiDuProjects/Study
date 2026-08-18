import { afterEach, describe, expect, it, vi } from "vitest";

import { CourseCatalogService } from "../src/course/index.js";
import { openDatabase, type AppDatabase } from "../src/db/index.js";
import type { CanvasConnection } from "../src/domain.js";

const databases: AppDatabase[] = [];

afterEach(() => {
  while (databases.length) databases.pop()?.close();
});

function database(): AppDatabase {
  const db = openDatabase(":memory:");
  databases.push(db);
  const now = 1_900_000_000_000;
  db.prepare(
    "INSERT INTO users(id, display_name, institution, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run("owner", "Student", "hanyang", now, now);
  db.prepare(
    `INSERT INTO canvas_connections(
       user_id, institution, base_url, canvas_user_id, canvas_name, pat_version,
       pat_iv, pat_ciphertext, pat_auth_tag, pat_hash, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "owner",
    "hanyang",
    "https://learning.hanyang.ac.kr",
    "42",
    "Student",
    Buffer.alloc(12),
    Buffer.alloc(1),
    Buffer.alloc(16),
    "hash",
    now,
    now,
  );
  return db;
}

const connection: CanvasConnection = {
  userId: "owner",
  institution: "hanyang",
  baseUrl: "https://learning.hanyang.ac.kr",
  accessToken: "test-pat",
  canvasUserId: "42",
  canvasName: "Student",
};

function course(id: number, name: string, code: string) {
  return {
    id,
    name,
    course_code: code,
    workflow_state: "available",
    start_at: "2026-09-01T00:00:00Z",
    end_at: "2026-12-20T00:00:00Z",
    html_url: `https://learning.hanyang.ac.kr/courses/${id}`,
    term: { id: 9, name: "2026 Fall" },
    enrollments: [{ id: id * 10, enrollment_state: "active" }],
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("CourseCatalogService", () => {
  it("syncs active and completed courses and snapshots only material changes", async () => {
    const db = database();
    const time = { value: 1_900_000_000_000 };
    let activeName = "Accounting";
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      return url.searchParams.get("enrollment_state") === "completed"
        ? json([course(8, "Past Seminar", "HIS-8")])
        : json([course(7, activeName, "ACC-7")]);
    }) as unknown as typeof globalThis.fetch;
    const service = new CourseCatalogService({
      db,
      getConnection: () => connection,
      fetch,
      clock: () => time.value,
      minIntervalSeconds: 0,
    });

    const first = await service.listForLecture(true);
    expect(first).toMatchObject({ stale: false, syncedAt: new Date(time.value).toISOString() });
    expect(first.courses).toEqual([
      expect.objectContaining({
        id: "7",
        code: "ACC-7",
        name: "Accounting",
        term: "2026 Fall",
        status: "active",
        source: "canvas",
      }),
      expect.objectContaining({ id: "8", status: "archived", archivedAt: expect.any(String) }),
    ]);
    expect(
      (db.prepare("SELECT COUNT(*) AS count FROM course_snapshots").get() as { count: number }).count,
    ).toBe(2);

    time.value += 60_000;
    await service.listForLecture(true);
    expect(
      (db.prepare("SELECT COUNT(*) AS count FROM course_snapshots").get() as { count: number }).count,
    ).toBe(2);

    activeName = "Advanced Accounting";
    time.value += 60_000;
    const changed = await service.listForLecture(true);
    expect(changed.courses[0]?.name).toBe("Advanced Accounting");
    expect(
      (db.prepare("SELECT COUNT(*) AS count FROM course_snapshots").get() as { count: number }).count,
    ).toBe(3);

    activeName = "Accounting";
    time.value += 60_000;
    await service.listForLecture(true);
    expect(
      (db.prepare("SELECT COUNT(*) AS count FROM course_snapshots").get() as { count: number }).count,
    ).toBe(4);
  });

  it("archives a previously active course after a complete nonempty sync no longer returns it", async () => {
    const db = database();
    const time = { value: 1_900_000_000_000 };
    let activeId = 7;
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.searchParams.get("enrollment_state") === "completed") return json([]);
      return json([course(activeId, activeId === 7 ? "Accounting" : "Economics", `C-${activeId}`)]);
    }) as unknown as typeof globalThis.fetch;
    const service = new CourseCatalogService({
      db,
      getConnection: () => connection,
      fetch,
      clock: () => time.value,
      minIntervalSeconds: 0,
    });

    await service.listForLecture(true);
    activeId = 9;
    time.value += 60_000;
    const result = await service.listForLecture(true);

    expect(result.courses).toEqual([
      expect.objectContaining({ id: "9", status: "active" }),
      expect.objectContaining({ id: "7", status: "archived", archivedAt: expect.any(String) }),
    ]);
    expect(
      db.prepare(
        "SELECT status, archived_at, present_in_latest_sync FROM course_catalog WHERE canvas_course_id = '7'",
      ).get(),
    ).toEqual({ status: "archived", archived_at: time.value, present_in_latest_sync: 0 });
    const archiveSnapshot = db.prepare(
      `SELECT metadata_json FROM course_snapshots
       WHERE canvas_course_id = '7' ORDER BY captured_at DESC, id DESC LIMIT 1`,
    ).get() as { metadata_json: string };
    expect(JSON.parse(archiveSnapshot.metadata_json)).toMatchObject({
      id: "7",
      status: "archived",
      archiveReason: "missing_from_latest_sync",
    });
  });

  it("keeps the last nonempty catalog stale instead of clearing or archiving it on zero", async () => {
    const db = database();
    const time = { value: 1_900_000_000_000 };
    let empty = false;
    const fetch = vi.fn(async () => json(empty ? [] : [course(7, "Accounting", "ACC-7")])) as unknown as typeof globalThis.fetch;
    const service = new CourseCatalogService({
      db,
      getConnection: () => connection,
      fetch,
      clock: () => time.value,
      minIntervalSeconds: 0,
    });

    await service.listForLecture(true);
    empty = true;
    time.value += 60_000;
    const result = await service.listForLecture(true);

    expect(result.stale).toBe(true);
    expect(result.courses).toEqual([
      expect.objectContaining({ id: "7", status: "active", archivedAt: null }),
    ]);
    expect(
      db.prepare(
        "SELECT status, archived_at, present_in_latest_sync FROM course_catalog WHERE canvas_course_id = '7'",
      ).get(),
    ).toEqual({ status: "active", archived_at: null, present_in_latest_sync: 1 });
    expect(
      db.prepare("SELECT last_error_code FROM course_sync_state WHERE user_id = 'owner'").get(),
    ).toEqual({ last_error_code: "empty_result" });
  });

  it("returns the last successful catalog as stale when Lecture refresh loses Canvas", async () => {
    const db = database();
    const time = { value: 1_900_000_000_000 };
    let failing = false;
    const fetch = vi.fn(async () => {
      if (failing) throw new Error("network detail that must stay internal");
      return json([course(7, "Accounting", "ACC-7")]);
    }) as unknown as typeof globalThis.fetch;
    const service = new CourseCatalogService({
      db,
      getConnection: () => connection,
      fetch,
      clock: () => time.value,
      minIntervalSeconds: 0,
    });

    await service.listForLecture(false);
    failing = true;
    time.value += 60_000;
    const result = await service.listForLecture(false);

    expect(result.stale).toBe(true);
    expect(result.courses).toHaveLength(1);
    expect(
      db.prepare("SELECT last_error_code FROM course_sync_state WHERE user_id = 'owner'").get(),
    ).toEqual({ last_error_code: "network_error" });
  });
});
