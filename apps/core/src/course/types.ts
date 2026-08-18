export type CourseCatalogStatus = "active" | "archived";

export interface CourseOption {
  id: string;
  code: string;
  name: string;
  term: string | null;
  folderName: string;
  label: string;
  status: CourseCatalogStatus;
  source: "canvas";
  startAt: string | null;
  endAt: string | null;
  lastSeenAt: string;
  archivedAt: string | null;
}

export interface CourseCatalogResponse {
  courses: CourseOption[];
  syncedAt: string | null;
  stale: boolean;
}

export class CourseCatalogError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 503,
  ) {
    super(message);
    this.name = "CourseCatalogError";
  }
}
