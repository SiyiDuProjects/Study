import { describe, expect, it } from "vitest";
import { currentCourse } from "./timetable";
import { DAILY_COURSE } from "../../shared/courses";
import type { Timetable } from "../../shared/timetable";
import { teachingWeek, weekSessionTitle } from "../../shared/timetable";

const course = { ...DAILY_COURSE, id: "101", source: "canvas" as const };
const timetable: Timetable = {
  timezone: "Asia/Seoul", term: { academicYear: 2026, semester: 2, name: "2026-2" },
  source: { asOf: "2026-08-30", label: "Portal" },
  meetings: [{ canvasCourseId: "101", courseNameKo: "한국어", courseNameZh: "韩语", weekdayIso: 1,
    startTime: "11:00", endTime: "13:00", locationCode: "104", locationName: null }]
};
describe("current course in Seoul", () => {
  it("labels school-calendar weeks independently of recording counts and before opening dates", () => {
    const calendar: Timetable = { ...timetable, teachingCalendar: { startsOn: "2026-09-01", weeks: 16,
      basis: "semester_start_seven_day_blocks", sourceUrl: "https://dormitory.hanyang.ac.kr/html/info/schedule", label: "Academic calendar" } };
    expect(teachingWeek(calendar, "101", "2026-09-07T02:00:00Z")).toBe(1);
    expect(teachingWeek(calendar, "101", "2026-09-07T15:00:00Z")).toBe(2);
    expect(teachingWeek(calendar, "101", "2026-08-25T02:00:00Z")).toBeNull();
    expect(teachingWeek(calendar, "daily", "2026-09-14T02:00:00Z")).toBeNull();
    expect(weekSessionTitle(course, "2026-09-14T02:00:00Z", calendar)).toContain("校历第2周");
  });
  it("matches the start boundary in Korea regardless of device timezone", () => {
    expect(currentCourse(timetable, [course], new Date("2026-09-07T02:00:00Z")).courseId).toBe("101");
  });
  it("ends at the exact class boundary", () => {
    expect(currentCourse(timetable, [course], new Date("2026-09-07T04:00:00Z")).courseId).toBe("daily");
  });
  it("does not invent a course or select an archived one", () => {
    expect(currentCourse(timetable, [], new Date("2026-09-07T02:30:00Z")).courseId).toBe("daily");
    expect(currentCourse(timetable, [{ ...course, isArchived: true }], new Date("2026-09-07T02:30:00Z")).courseId).toBe("daily");
  });
  it("rejects ambiguous and stale semester schedules", () => {
    expect(currentCourse({ ...timetable, meetings: [...timetable.meetings, ...timetable.meetings] }, [course], new Date("2026-09-07T02:30:00Z")).courseId).toBe("daily");
    expect(currentCourse(timetable, [course], new Date("2027-09-06T02:30:00Z")).courseId).toBe("daily");
  });
});
