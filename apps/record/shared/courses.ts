export type CourseSource = "canvas" | "daily" | "legacy";

export interface CourseOption {
  id: string;
  code: string;
  name: string;
  term: string;
  folderName: string;
  label: string;
  source: CourseSource;
  workflowState: string | null;
  startAt: string | null;
  endAt: string | null;
  isArchived: boolean;
  lastSeenAt?: string;
  archivedAt?: string | null;
}

export const DAILY_COURSE_ID = "daily";

// Daily is the only local option. Every academic course is supplied by the
// authenticated Hanyang connection in Study Core.
export const DAILY_COURSE: CourseOption = {
  id: DAILY_COURSE_ID,
  code: DAILY_COURSE_ID,
  name: "日常 / 不选课程",
  term: "",
  folderName: DAILY_COURSE_ID,
  label: "日常 / 不选课程",
  source: "daily",
  workflowState: null,
  startAt: null,
  endAt: null,
  isArchived: false
};

export function courseFolderName(course: Pick<CourseOption, "id" | "code" | "name">): string {
  const prefix = course.code.trim() || course.id;
  return `${prefix}_${course.name}`;
}
