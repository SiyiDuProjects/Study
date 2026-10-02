import { DAILY_COURSE_ID, type CourseOption } from "../../shared/courses";
import type { Timetable } from "../../shared/timetable";

export function currentCourse(timetable: Timetable | null, courses: CourseOption[], now: Date) {
  if (!timetable) return { label: "请选课", courseId: DAILY_COURSE_ID, message: "课表暂不可用，请手动选课；也可快速录播。" };
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: timetable.timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(now).map(part => [part.type, part.value]));
  const month = Number(parts.month);
  // Never reuse a previous semester's recurring timetable indefinitely.
  if (Number(parts.year) !== timetable.term.academicYear ||
      (timetable.term.semester === 2 ? month < 9 || month > 12 : month < 3 || month > 6)) {
    return { label: "请选课", courseId: DAILY_COURSE_ID, message: "当前日期不在这份课表的学期内，请手动选课。" };
  }
  const weekday = new Date(`${parts.year}-${parts.month}-${parts.day}T12:00:00Z`).getUTCDay() || 7;
  const time = `${parts.hour}:${parts.minute}`;
  const matches = timetable.meetings.filter(m => m.weekdayIso === weekday && m.startTime <= time && time < m.endTime);
  if (matches.length !== 1) return { label: matches.length ? "请选课" : "当前无课", courseId: DAILY_COURSE_ID, message: matches.length ? "当前课表有冲突，请手动选课。" : "当前没有课表课程，可快速录播或手动选课。" };
  const meeting = matches[0];
  const course = courses.find(c => c.id === meeting.canvasCourseId && !c.isArchived);
  if (!course) return { label: "请选课", courseId: DAILY_COURSE_ID, message: `课表显示 ${meeting.courseNameZh}，但课程尚未同步，请刷新课程。` };
  return { label: "已匹配", courseId: course.id, message: `首尔时间 ${meeting.startTime}–${meeting.endTime} · ${meeting.courseNameZh} · ${meeting.locationName ?? meeting.locationCode}。按常规课表匹配，临时调课请手动更换。` };
}

