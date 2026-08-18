import type { InstitutionKey } from "../domain.js";

export type CanvasId = string | number;

export type EnrollmentState =
  | "active"
  | "invited_or_pending"
  | "completed"
  | "deleted";

export interface CanvasConnectionStatus {
  connected: true;
  institution: InstitutionKey;
  institutionName: string;
  baseUrl: string;
  profile: {
    id: string;
    name: string;
    sortableName: string | null;
    loginId: string | null;
    primaryEmail: string | null;
    avatarUrl: string | null;
  };
}

export interface CanvasEnrollmentSummary {
  id: string;
  type: string | null;
  role: string | null;
  state: string | null;
  currentScore: number | null;
  currentGrade: string | null;
  finalScore: number | null;
  finalGrade: string | null;
}

export interface CanvasCourse {
  id: string;
  name: string;
  courseCode: string | null;
  workflowState: string | null;
  startAt: string | null;
  endAt: string | null;
  timeZone: string | null;
  isPublic: boolean;
  syllabusBody: string | null;
  syllabusText: string | null;
  htmlUrl: string;
  term: {
    id: string;
    name: string;
    startAt: string | null;
    endAt: string | null;
  } | null;
  teachers: Array<{
    id: string;
    name: string;
    displayName: string | null;
    avatarImageUrl: string | null;
  }>;
  enrollment: CanvasEnrollmentSummary | null;
}

export type NormalizedSubmissionStatus =
  | "unsubmitted"
  | "submitted"
  | "graded"
  | "missing"
  | "excused";

export interface CanvasSubmission {
  id: string | null;
  assignmentId: string;
  courseId: string;
  status: NormalizedSubmissionStatus;
  workflowState: string | null;
  submittedAt: string | null;
  gradedAt: string | null;
  score: number | null;
  grade: string | null;
  attempt: number | null;
  late: boolean;
  missing: boolean;
  excused: boolean;
  secondsLate: number;
  submissionType: string | null;
  attachments: Array<{
    id: string;
    filename: string;
    displayName: string | null;
    contentType: string | null;
    size: number | null;
  }>;
  history: CanvasSubmission[];
}

export interface CanvasAssignment {
  id: string;
  courseId: string;
  name: string;
  descriptionHtml: string | null;
  descriptionText: string | null;
  dueAt: string | null;
  unlockAt: string | null;
  lockAt: string | null;
  pointsPossible: number | null;
  position: number | null;
  published: boolean;
  workflowState: string | null;
  submissionTypes: string[];
  allowedExtensions: string[];
  hasSubmittedSubmissions: boolean;
  htmlUrl: string | null;
  submission: CanvasSubmission | null;
}

export interface CanvasAnnouncement {
  id: string;
  courseId: string | null;
  title: string;
  messageHtml: string | null;
  messageText: string | null;
  postedAt: string | null;
  delayedPostAt: string | null;
  lastReplyAt: string | null;
  authorName: string | null;
  htmlUrl: string | null;
  readState: string | null;
  locked: boolean;
  published: boolean;
}

export interface CanvasModuleItem {
  id: string;
  moduleId: string;
  title: string;
  type: string | null;
  position: number | null;
  indent: number;
  contentId: string | null;
  htmlUrl: string | null;
  externalUrl: string | null;
  published: boolean;
  completionRequirement: {
    type: string | null;
    completed: boolean;
    minScore: number | null;
  } | null;
  contentDetails: {
    dueAt: string | null;
    unlockAt: string | null;
    lockAt: string | null;
    pointsPossible: number | null;
  } | null;
}

export interface CanvasModule {
  id: string;
  name: string;
  position: number | null;
  unlockAt: string | null;
  requireSequentialProgress: boolean;
  prerequisiteModuleIds: string[];
  state: string | null;
  completedAt: string | null;
  published: boolean;
  items: CanvasModuleItem[];
}

export interface CanvasCourseTab {
  id: string;
  label: string;
  type: string | null;
  position: number | null;
  hidden: boolean;
  visibility: string | null;
  htmlUrl: string | null;
  externalToolId: string | null;
}

export interface CanvasQuiz {
  id: string;
  courseId: string;
  title: string;
  descriptionHtml: string | null;
  descriptionText: string | null;
  quizType: string | null;
  dueAt: string | null;
  unlockAt: string | null;
  lockAt: string | null;
  timeLimitMinutes: number | null;
  allowedAttempts: number | null;
  scoringPolicy: string | null;
  pointsPossible: number | null;
  questionCount: number | null;
  published: boolean;
  htmlUrl: string | null;
}

export interface CanvasDiscussionEntry {
  id: string;
  topicId: string;
  userId: string | null;
  userName: string | null;
  messageHtml: string | null;
  messageText: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  readState: string | null;
  deleted: boolean;
  replies: CanvasDiscussionEntry[];
}

export interface CanvasDiscussionTopic {
  id: string;
  courseId: string;
  title: string;
  messageHtml: string | null;
  messageText: string | null;
  postedAt: string | null;
  lastReplyAt: string | null;
  discussionType: string | null;
  published: boolean;
  locked: boolean;
  subscribed: boolean;
  unreadCount: number | null;
  htmlUrl: string | null;
  authorName: string | null;
}

export interface CanvasPageSummary {
  url: string;
  title: string;
  createdAt: string | null;
  updatedAt: string | null;
  published: boolean;
  frontPage: boolean;
  htmlUrl: string | null;
}

export interface CanvasPage extends CanvasPageSummary {
  bodyHtml: string | null;
  bodyText: string | null;
}

export interface CanvasFile {
  id: string;
  folderId: string | null;
  displayName: string;
  filename: string;
  contentType: string | null;
  size: number | null;
  createdAt: string | null;
  updatedAt: string | null;
  modifiedAt: string | null;
  unlockAt: string | null;
  lockAt: string | null;
  locked: boolean;
  hidden: boolean;
}

export interface CanvasCalendarEvent {
  id: string;
  type: string;
  title: string;
  descriptionHtml: string | null;
  descriptionText: string | null;
  startAt: string | null;
  endAt: string | null;
  allDay: boolean;
  contextCode: string | null;
  courseId: string | null;
  workflowState: string | null;
  locationName: string | null;
  htmlUrl: string | null;
}

export interface CanvasUpcomingWorkItem {
  id: string;
  courseId: string | null;
  type: string;
  title: string;
  date: string | null;
  dueAt: string | null;
  htmlUrl: string | null;
  pointsPossible: number | null;
  completed: boolean;
  submissionStatus: NormalizedSubmissionStatus | null;
}

export interface CanvasGrade {
  enrollmentId: string;
  courseId: string;
  enrollmentState: string | null;
  currentScore: number | null;
  currentGrade: string | null;
  finalScore: number | null;
  finalGrade: string | null;
  currentPoints: number | null;
}

export interface CanvasWeeklySummary {
  window: {
    startAt: string;
    endAt: string;
  };
  courses: CanvasCourse[];
  upcomingWork: CanvasUpcomingWorkItem[];
  calendarEvents: CanvasCalendarEvent[];
  announcements: CanvasAnnouncement[];
  counts: {
    courses: number;
    upcomingWork: number;
    incompleteWork: number;
    calendarEvents: number;
    announcements: number;
  };
}

export interface ListOptions {
  limit?: number;
}

export interface ListCoursesOptions extends ListOptions {
  enrollmentState?: EnrollmentState;
}

export interface ListAssignmentsOptions extends ListOptions {
  bucket?: "upcoming" | "future" | "past" | "overdue" | "undated" | "ungraded";
  includeSubmission?: boolean;
}

export interface ListAnnouncementsOptions extends ListOptions {
  startAt?: string;
  endAt?: string;
  activeOnly?: boolean;
}

export interface ListModulesOptions extends ListOptions {
  includeItems?: boolean;
}

export interface ListDiscussionTopicsOptions extends ListOptions {
  orderBy?: "position" | "recent_activity" | "title";
  onlyAnnouncements?: boolean;
}

export interface ListFilesOptions extends ListOptions {
  searchTerm?: string;
  contentTypes?: string[];
  sort?: "name" | "size" | "created_at" | "updated_at";
  order?: "asc" | "desc";
}

export interface TimeWindowOptions extends ListOptions {
  startAt?: string;
  endAt?: string;
  courseIds?: CanvasId[];
}

export interface ListCalendarEventsOptions extends TimeWindowOptions {
  type?: "event" | "assignment";
}

export interface UpcomingWorkOptions extends TimeWindowOptions {
  includeCompleted?: boolean;
}

export interface GradeOptions extends ListOptions {
  courseId?: CanvasId;
  includeCompleted?: boolean;
}

export interface WeeklySummaryOptions {
  startAt?: string;
  endAt?: string;
  courseIds?: CanvasId[];
  limitPerCollection?: number;
}
