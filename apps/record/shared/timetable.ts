import { z } from "zod";

export const timetableSchema = z.object({
  timezone: z.literal("Asia/Seoul"),
  term: z.object({ academicYear: z.number().int(), semester: z.number().int(), name: z.string() }),
  source: z.object({ asOf: z.string(), label: z.string() }),
  teachingCalendar: z.object({
    startsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), weeks: z.number().int().min(1).max(30),
    basis: z.literal("semester_start_seven_day_blocks"), sourceUrl: z.string().url(), label: z.string()
  }).optional(),
  meetings: z.array(z.object({
    canvasCourseId: z.string(), courseNameKo: z.string(), courseNameZh: z.string(),
    weekdayIso: z.number().int().min(1).max(7),
    startTime: z.string().regex(/^\d{2}:\d{2}$/), endTime: z.string().regex(/^\d{2}:\d{2}$/),
    locationCode: z.string(), locationName: z.string().nullable()
  }))
});
export type Timetable = z.infer<typeof timetableSchema>;

export function teachingWeek(timetable: Timetable | null | undefined, courseId: string, startedAt: string): number | null {
  const calendar = timetable?.teachingCalendar;
  if (!calendar || !timetable.meetings.some(m => m.canvasCourseId === courseId)) return null;
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(startedAt));
  const elapsedDays = (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${calendar.startsOn}T00:00:00Z`)) / 86_400_000;
  const week = Math.floor(elapsedDays / 7) + 1;
  return week >= 1 && week <= calendar.weeks ? week : null;
}

export function weekSessionTitle(course: { id: string; name: string }, startedAt: string, timetable?: Timetable | null): string {
  const week = teachingWeek(timetable, course.id, startedAt);
  const date = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(startedAt));
  return `${course.name} · ${week ? `校历第${week}周 · ` : ""}${date}`;
}
