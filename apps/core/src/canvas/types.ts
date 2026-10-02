import type { InstitutionKey } from "../domain.js";
import type { CanvasApiError } from "./errors.js";

export type CanvasId = string | number;

/** nextCursor is opaque. Null means this query has no further records. */
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export type SourceResult<T> =
  | { ok: true; result: Page<T>; error: null }
  | { ok: false; result: null; error: ReturnType<CanvasApiError["toJSON"]> };

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
  | "excused"
  | "resubmission_required"
  | "unknown";

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
  late: boolean | null;
  missing: boolean | null;
  excused: boolean | null;
  redoRequest: boolean | null;
  extraAttempts: number | null;
  secondsLate: number | null;
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

export interface CanvasSubmissionComment {
  id: string;
  authorId: string | null;
  authorName: string | null;
  commentHtml: string | null;
  commentText: string | null;
  createdAt: string | null;
  attachments: Array<{
    id: string;
    filename: string;
    displayName: string | null;
    contentType: string | null;
    size: number | null;
  }>;
}

export interface CanvasCourseSubmission extends CanvasSubmission {
  assignment: {
    id: string;
    name: string;
    dueAt: string | null;
    pointsPossible: number | null;
    htmlUrl: string | null;
  };
  comments: CanvasSubmissionComment[];
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
  lockedForUser: boolean | null;
  lockExplanation: string | null;
  allowedAttempts: number | null;
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

export interface CanvasAssignmentPage extends Page<CanvasAssignment> {
  coverage: {
    courseId: string;
    selection: string;
    source: "all_assignments" | "upstream_bucket";
    submissionIncluded: boolean;
    queryExhausted: boolean;
    checkedAt: string;
  };
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
  itemCount: number | null;
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
  hasMoreReplies: boolean;
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

export interface CanvasFileDownload {
  file: CanvasFile;
  bytes: Uint8Array;
  contentType: string;
}

export interface CanvasConversationParticipant {
  id: string;
  name: string;
  fullName: string | null;
}

export interface CanvasConversationSummary {
  id: string;
  subject: string;
  workflowState: string | null;
  lastMessage: string | null;
  lastMessageAt: string | null;
  messageCount: number;
  subscribed: boolean;
  private: boolean;
  starred: boolean;
  contextCode: string | null;
  contextName: string | null;
  participants: CanvasConversationParticipant[];
}

export interface CanvasConversationMessage {
  id: string;
  createdAt: string | null;
  authorId: string | null;
  generated: boolean;
  bodyHtml: string | null;
  bodyText: string | null;
  attachments: Array<{
    id: string;
    filename: string;
    displayName: string | null;
    contentType: string | null;
    size: number | null;
  }>;
  forwardedMessages: CanvasConversationMessage[];
}

export interface CanvasConversation extends CanvasConversationSummary {
  messages: CanvasConversationMessage[];
}

export interface CanvasCalendarEvent {
  id: string;
  type: string;
  title: string;
  createdAt: string | null;
  updatedAt: string | null;
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
  completed: boolean | null;
  submissionStatus: NormalizedSubmissionStatus | null;
  submissionFlags: {
    submitted: boolean | null;
    graded: boolean | null;
    needsGrading: boolean | null;
    missing: boolean | null;
    excused: boolean | null;
    redoRequest: boolean | null;
  };
  plannerOverride: { markedComplete: boolean | null; dismissed: boolean | null } | null;
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
  announcementsWindow: {
    startAt: string;
    endAt: string;
  };
  sources: {
    courses: SourceResult<CanvasCourse>;
    upcomingWork: SourceResult<CanvasUpcomingWorkItem>;
    calendarEvents: SourceResult<CanvasCalendarEvent>;
    announcements: SourceResult<CanvasAnnouncement>;
  };
}

export interface ListOptions {
  limit?: number;
  cursor?: string;
}

export interface ListCoursesOptions extends ListOptions {
  enrollmentState?: EnrollmentState;
  courseIds?: CanvasId[];
  termId?: CanvasId;
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

export type ListModulesOptions = ListOptions;

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

export type ConversationScope = "inbox" | "unread" | "starred" | "archived" | "sent";

export interface ListConversationsOptions extends ListOptions {
  scope?: ConversationScope;
}

export interface ListCourseSubmissionsOptions extends ListOptions {
  includeHistory?: boolean;
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
  announcementsStartAt?: string;
  courseIds?: CanvasId[];
  limitPerCollection?: number;
}
