import { afterEach, describe, expect, it, vi } from "vitest";

import { CourseCatalogService } from "../src/course/index.js";
import { openDatabase, type AppDatabase } from "../src/db/index.js";
import type { CanvasConnection } from "../src/domain.js";
import { getImportedTimetableOwnerId } from "../src/timetable.js";

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

  it("reads every active and completed course page before publishing the catalog", async () => {
    const db = database();
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const completed = url.searchParams.get("enrollment_state") === "completed";
      const page = Number(url.searchParams.get("page") ?? 1);
      const start = completed ? 1000 : 0;
      const count = page === 3 ? 1 : 100;
      const rows = Array.from({ length: count }, (_, index) => {
        const id = start + (page - 1) * 100 + index + 1;
        return course(id, `Course ${id}`, `C-${id}`);
      });
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (page < 3) {
        url.searchParams.set("page", String(page + 1));
        headers.link = `<${url.href}>; rel="next"`;
      }
      return new Response(JSON.stringify(rows), { headers });
    }) as unknown as typeof globalThis.fetch;
    const service = new CourseCatalogService({ db, getConnection: () => connection, fetch, minIntervalSeconds: 0 });
    const result = await service.listForLecture(true);
    expect(result.stale).toBe(false);
    expect(result.courses).toHaveLength(402);
    expect(result.courses).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "201", status: "active" }),
      expect.objectContaining({ id: "1201", status: "archived" }),
    ]));
    expect(fetch).toHaveBeenCalledTimes(6);
  });

  it("retains the previous complete catalog when a continuation page fails", async () => {
    const db = database();
    let failContinuation = false;
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.searchParams.get("enrollment_state") === "completed") return json([]);
      if (!failContinuation) return json([course(999, "Keep this course", "C-999")]);
      if (url.searchParams.get("page") === "2") return json({}, 503);
      url.searchParams.set("page", "2");
      return new Response(JSON.stringify(Array.from({ length: 200 }, (_, index) => course(index + 1, "New course", `C-${index + 1}`))), {
        headers: { "content-type": "application/json", link: `<${url.href}>; rel="next"` },
      });
    }) as unknown as typeof globalThis.fetch;
    const service = new CourseCatalogService({ db, getConnection: () => connection, fetch, minIntervalSeconds: 0 });
    const before = await service.listForLecture(true);
    failContinuation = true;
    const after = await service.listForLecture(true);
    expect(after.stale).toBe(true);
    expect(after.courses).toEqual(before.courses);
    expect(db.prepare("SELECT COUNT(*) AS count FROM course_catalog").get()).toEqual({ count: 1 });
  });

  it("does not authorize an internal timetable merely because an App user is the sole connection", async () => {
    const db = database();
    const differentId = getImportedTimetableOwnerId() === "1" ? "2" : "1";
    db.prepare("UPDATE canvas_connections SET canvas_user_id = ?").run(differentId);
    const fetch = vi.fn() as unknown as typeof globalThis.fetch;
    const service = new CourseCatalogService({ db, getConnection: () => connection, fetch, minIntervalSeconds: 0 });
    await expect(service.getTimetableForLecture()).rejects.toMatchObject({ code: "timetable_owner_unavailable", status: 403 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("verifies the selected timetable connection against live Canvas identity", async () => {
    const db = database();
    const importedOwner = getImportedTimetableOwnerId();
    db.prepare("UPDATE canvas_connections SET canvas_user_id = ?").run(importedOwner);
    let profileId = importedOwner === "1" ? "2" : "1";
    const fetch = vi.fn(async () => json({ id: profileId, name: "Synthetic student" })) as unknown as typeof globalThis.fetch;
    const service = new CourseCatalogService({
      db, getConnection: () => connection, fetch, minIntervalSeconds: 0,
      clock: () => Date.parse("2026-09-07T00:00:00Z"),
    });
    await expect(service.getTimetableForLecture()).rejects.toMatchObject({ code: "permission_denied" });
    profileId = importedOwner;
    await expect(service.getTimetableForLecture()).resolves.toMatchObject({ meetings: expect.any(Array) });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
