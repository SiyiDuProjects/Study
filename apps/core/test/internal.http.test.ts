import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { CanvasApiError } from "../src/canvas/errors.js";
import type { CourseCatalogService } from "../src/course/index.js";
import { createInternalRouter } from "../src/internal/http.js";
import { getHanyangTimetable, getImportedTimetableOwnerId } from "../src/timetable.js";

describe("internal Lecture timetable", () => {
  const token = "synthetic-internal-service-token-for-tests";

  it("requires the service token and returns the owner-verified import without a duplicate calendar", async () => {
    const timetable = getHanyangTimetable(getImportedTimetableOwnerId(), new Date("2026-09-07T00:00:00Z"));
    const getTimetableForLecture = vi.fn(async () => timetable);
    const service = { getTimetableForLecture } as unknown as CourseCatalogService;
    const app = express().use(createInternalRouter(service, token));
    await request(app).get("/internal/lecture/timetable").expect(401);
    expect(getTimetableForLecture).not.toHaveBeenCalled();
    const result = await request(app).get("/internal/lecture/timetable").set("Authorization", `Bearer ${token}`).expect(200);
    expect(result.body).toEqual(timetable);
    expect(result.headers["cache-control"]).toBe("no-store");
    expect(getTimetableForLecture).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["permission_denied", 403],
    ["not_found", 404],
  ] as const)("preserves %s without exposing owner or upstream details", async (code, status) => {
    const service = {
      getTimetableForLecture: async () => { throw new CanvasApiError(code, "Private diagnostic detail", { status }); },
    } as unknown as CourseCatalogService;
    const app = express().use(createInternalRouter(service, token));
    const result = await request(app).get("/internal/lecture/timetable").set("Authorization", `Bearer ${token}`).expect(status);
    expect(result.body).toEqual({ error: code });
  });
});
