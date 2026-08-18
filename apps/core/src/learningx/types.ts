export type LearningXFeature = "attendance" | "modules";

export interface LearningXAttendanceItem {
  id: string;
  courseId: string;
  title: string;
  type: string | null;
  attendanceStatus: string | null;
  useAttendance: boolean;
  completed: boolean;
  dueAt: string | null;
  unlockAt: string | null;
  completedAt: string | null;
  progressSeconds: number | null;
  lastAtSeconds: number | null;
  required: boolean;
  durationSeconds: number | null;
  progressSupported: boolean | null;
  viewerUrl: string;
}

export interface LearningXModule {
  id: string;
  courseId: string;
  name: string;
  position: number | null;
  requiredCount: number | null;
  completedCount: number | null;
  viewerUrl: string;
  items: LearningXAttendanceItem[];
}
