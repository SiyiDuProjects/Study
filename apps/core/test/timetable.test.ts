import { describe, expect, it } from "vitest";

import { getHanyangTimetable, getImportedTimetableOwnerId } from "../src/timetable.js";

describe("imported Hanyang timetable", () => {
  const owner = getImportedTimetableOwnerId();

  it("returns an isolated timetable only for its verified Canvas owner", () => {
    const now = new Date("2026-09-07T00:00:00Z");
    const timetable = getHanyangTimetable(owner, now);
    expect(timetable).toMatchObject({
      institution: "hanyang", timezone: "Asia/Seoul", totalCredits: 16,
      term: { academicYear: 2026, semester: 2 },
      teachingCalendar: { startsOn: "2026-09-01", weeks: 16, basis: "semester_start_seven_day_blocks" },
    });
    expect(timetable.meetings).toHaveLength(7);
    expect(timetable).not.toHaveProperty("ownerCanvasUserId");
    timetable.meetings.length = 0;
    expect(getHanyangTimetable(owner, now).meetings).toHaveLength(7);
    expect(() => getHanyangTimetable(owner === "1" ? "2" : "1", now)).toThrow(expect.objectContaining({ code: "permission_denied" }));
    expect(() => getHanyangTimetable("", now)).toThrow(expect.objectContaining({ code: "permission_denied" }));
  });

  it("checks teaching-term boundaries in Seoul rather than the server timezone", () => {
    expect(() => getHanyangTimetable(owner, new Date("2026-08-31T14:59:59.999Z"))).toThrow(expect.objectContaining({ code: "not_found" }));
    expect(getHanyangTimetable(owner, new Date("2026-08-31T15:00:00Z")).meetings).toHaveLength(7);
    expect(getHanyangTimetable(owner, new Date("2026-12-21T14:59:59.999Z")).meetings).toHaveLength(7);
    expect(() => getHanyangTimetable(owner, new Date("2026-12-21T15:00:00Z"))).toThrow(expect.objectContaining({ code: "not_found" }));
  });

  it("does not recycle a previous year's private timetable for a new term", () => {
    expect(() => getHanyangTimetable(owner, new Date("2027-09-07T00:00:00Z"))).toThrow(expect.objectContaining({ code: "not_found" }));
    expect(() => getHanyangTimetable(owner, new Date("invalid"))).toThrow(expect.objectContaining({ code: "invalid_argument" }));
  });
});
