import { readFileSync } from "node:fs";
import { CanvasApiError } from "./canvas/errors.js";

export type HanyangWeekday =
  | "monday"
  | "tuesday"
  | "wednesday"
  | "thursday"
  | "friday";

export interface HanyangTimetableMeeting {
  canvasCourseId: string;
  canvasCourseCode: string;
  courseNameKo: string;
  courseNameZh: string;
  weekday: HanyangWeekday;
  weekdayIso: number;
  startTime: string;
  endTime: string;
  locationCode: string;
  locationName: string | null;
}

export interface HanyangTimetable {
  institution: "hanyang";
  term: {
    id: string;
    name: string;
    academicYear: number;
    semester: number;
  };
  timezone: "Asia/Seoul";
  totalCredits: number;
  source: {
    kind: "official_portal_timetable";
    label: string;
    asOf: string;
  };
  teachingCalendar: {
    startsOn: string;
    weeks: number;
    basis: "semester_start_seven_day_blocks";
    sourceUrl: string;
    label: string;
  };
  meetings: HanyangTimetableMeeting[];
  interpretation: {
    recurringBaseline: true;
    matchCourseBy: ["canvasCourseId", "canvasCourseCode", "courseNameKo"];
    temporaryNoticeRule: string;
    missingNoticeRule: string;
  };
}

interface TimetableImport {
  ownerCanvasUserId: string | null;
  timetable: HanyangTimetable;
}

const imported = JSON.parse(readFileSync(new URL("./data/hanyang-timetable.json", import.meta.url), "utf8")) as TimetableImport;

export function getImportedTimetableOwnerId(): string {
  if (typeof imported.ownerCanvasUserId !== "string" || !/^[1-9]\d*$/.test(imported.ownerCanvasUserId)) {
    throw new CanvasApiError("configuration_error", "The imported timetable has no verified Canvas owner.");
  }
  return imported.ownerCanvasUserId;
}

/** The caller must obtain this ID from Canvas connectionStatus, not a cached App identity. */
export function getHanyangTimetable(verifiedCanvasUserId: string, now = new Date()): HanyangTimetable {
  if (verifiedCanvasUserId !== getImportedTimetableOwnerId()) {
    throw new CanvasApiError("permission_denied", "No imported timetable is available for this Canvas account.", { status: 403 });
  }
  const calendar = imported.timetable.teachingCalendar;
  const startsAt = Date.parse(calendar?.startsOn + "T00:00:00Z");
  if (!Number.isFinite(startsAt) || !Number.isInteger(calendar.weeks) || calendar.weeks < 1 || calendar.weeks > 30) {
    throw new CanvasApiError("configuration_error", "The imported timetable has an invalid teaching calendar.");
  }
  if (!Number.isFinite(now.getTime())) {
    throw new CanvasApiError("invalid_argument", "The timetable lookup date is invalid.");
  }
  const dateInSeoul = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
  const day = Date.parse(dateInSeoul + "T00:00:00Z");
  const endsBefore = startsAt + calendar.weeks * 7 * 86_400_000;
  if (day < startsAt || day >= endsBefore) {
    throw new CanvasApiError("not_found", "No imported timetable covers the current teaching term.", { status: 404 });
  }
  return structuredClone(imported.timetable);
}
