import { z } from "zod";
import { envelopeSchema, pageSchema } from "./contracts.js";

const nullableString = z.string().nullable();
const nullableNumber = z.number().nullable();
const recordId = z.string().regex(/^[1-9]\d*$/);

const enrollmentSchema = z
  .object({
    id: z.string(),
    type: nullableString,
    role: nullableString,
    state: nullableString,
    currentScore: nullableNumber,
    currentGrade: nullableString,
    finalScore: nullableNumber,
    finalGrade: nullableString,
  })
  .strict();

const courseSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    courseCode: nullableString,
    workflowState: nullableString,
    startAt: nullableString,
    endAt: nullableString,
    timeZone: nullableString,
    isPublic: z.boolean(),
    syllabusBody: nullableString,
    syllabusText: nullableString,
    htmlUrl: z.string(),
    term: z
      .object({
        id: z.string(),
        name: z.string(),
        startAt: nullableString,
        endAt: nullableString,
      })
      .strict()
      .nullable(),
    teachers: z.array(
      z
        .object({
          id: z.string(),
          name: z.string(),
          displayName: nullableString,
          avatarImageUrl: nullableString,
        })
        .strict(),
    ),
    enrollment: enrollmentSchema.nullable(),
  })
  .strict();

const timetableMeetingSchema = z
  .object({
    canvasCourseId: z.string(),
    canvasCourseCode: z.string(),
    courseNameKo: z.string(),
    courseNameZh: z.string(),
    weekday: z.enum(["monday", "tuesday", "wednesday", "thursday", "friday"]),
    weekdayIso: z.number().int().min(1).max(5),
    startTime: z.string().regex(/^\d{2}:\d{2}$/),
    endTime: z.string().regex(/^\d{2}:\d{2}$/),
    locationCode: z.string(),
    locationName: nullableString,
  })
  .strict();

const timetableSchema = z
  .object({
    institution: z.literal("hanyang"),
    term: z
      .object({
        id: z.string(),
        name: z.string(),
        academicYear: z.number().int(),
        semester: z.number().int().positive(),
      })
      .strict(),
    timezone: z.literal("Asia/Seoul"),
    teachingCalendar: z.object({
      startsOn: z.string().date(),
      weeks: z.number().int().positive(),
      basis: z.string(),
      sourceUrl: z.string().url(),
      label: z.string(),
    }).strict(),
    totalCredits: z.number().int().nonnegative(),
    source: z
      .object({
        kind: z.literal("official_portal_timetable"),
        label: z.string(),
        asOf: z.string().date(),
      })
      .strict(),
    meetings: z.array(timetableMeetingSchema),
    interpretation: z
      .object({
        recurringBaseline: z.literal(true),
        matchCourseBy: z.tuple([
          z.literal("canvasCourseId"),
          z.literal("canvasCourseCode"),
          z.literal("courseNameKo"),
        ]),
        temporaryNoticeRule: z.string(),
        missingNoticeRule: z.string(),
      })
      .strict(),
  })
  .strict();

const submissionStatusSchema = z.enum([
  "unsubmitted",
  "submitted",
  "graded",
  "missing",
  "excused",
  "resubmission_required",
  "unknown",
]);

const attachmentSchema = z
  .object({
    id: z.string(),
    filename: z.string(),
    displayName: nullableString,
    contentType: nullableString,
    size: nullableNumber,
  })
  .strict();

const submissionShape = {
  id: nullableString,
  assignmentId: recordId,
  courseId: recordId,
  status: submissionStatusSchema,
  workflowState: nullableString,
  submittedAt: nullableString,
  gradedAt: nullableString,
  score: nullableNumber,
  grade: nullableString,
  attempt: nullableNumber,
  late: z.boolean().nullable(),
  missing: z.boolean().nullable(),
  excused: z.boolean().nullable(),
  redoRequest: z.boolean().nullable(),
  extraAttempts: nullableNumber,
  secondsLate: nullableNumber,
  submissionType: nullableString,
  attachments: z.array(attachmentSchema),
} as const;

// normalizeSubmission deliberately limits history to one level; entries in the
// history array always carry an empty history of their own.
const submissionHistoryItemSchema = z
  .object({
    ...submissionShape,
    history: z.array(z.unknown()).max(0),
  })
  .strict();

const submissionSchema = z
  .object({
    ...submissionShape,
    history: z.array(submissionHistoryItemSchema),
  })
  .strict();

const submissionCommentSchema = z
  .object({
    id: z.string(),
    authorId: nullableString,
    authorName: nullableString,
    commentHtml: nullableString,
    commentText: nullableString,
    createdAt: nullableString,
    attachments: z.array(attachmentSchema),
  })
  .strict();

const courseSubmissionSchema = submissionSchema
  .extend({
    assignment: z
      .object({
        id: z.string(),
        name: z.string(),
        dueAt: nullableString,
        pointsPossible: nullableNumber,
        htmlUrl: nullableString,
      })
      .strict(),
    comments: z.array(submissionCommentSchema),
  })
  .strict();

const assignmentSchema = z
  .object({
    id: recordId,
    courseId: recordId,
    name: z.string(),
    descriptionHtml: nullableString,
    descriptionText: nullableString,
    dueAt: nullableString,
    unlockAt: nullableString,
    lockAt: nullableString,
    lockedForUser: z.boolean().nullable().describe("Canvas user-specific lock; null means unknown. A null lockAt does not establish permission to submit."),
    lockExplanation: nullableString,
    allowedAttempts: nullableNumber,
    pointsPossible: nullableNumber,
    position: nullableNumber,
    published: z.boolean(),
    workflowState: nullableString,
    submissionTypes: z.array(z.string()),
    allowedExtensions: z.array(z.string()),
    hasSubmittedSubmissions: z.boolean().describe("Whether ANY student has submitted. Never use this as the current student's submission status."),
    htmlUrl: nullableString,
    submission: submissionSchema.nullable(),
  })
  .strict();

const announcementSchema = z
  .object({
    id: z.string(),
    courseId: nullableString,
    title: z.string(),
    messageHtml: nullableString,
    messageText: nullableString,
    postedAt: nullableString,
    delayedPostAt: nullableString,
    lastReplyAt: nullableString,
    authorName: nullableString,
    htmlUrl: nullableString,
    readState: nullableString,
    locked: z.boolean(),
    published: z.boolean(),
  })
  .strict();

const moduleItemSchema = z
  .object({
    id: z.string(),
    moduleId: z.string(),
    title: z.string(),
    type: nullableString,
    position: nullableNumber,
    indent: z.number(),
    contentId: nullableString,
    htmlUrl: nullableString,
    externalUrl: nullableString,
    published: z.boolean(),
    completionRequirement: z
      .object({
        type: nullableString,
        completed: z.boolean(),
        minScore: nullableNumber,
      })
      .strict()
      .nullable(),
    contentDetails: z
      .object({
        dueAt: nullableString,
        unlockAt: nullableString,
        lockAt: nullableString,
        pointsPossible: nullableNumber,
      })
      .strict()
      .nullable(),
  })
  .strict();

const moduleSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    position: nullableNumber,
    unlockAt: nullableString,
    requireSequentialProgress: z.boolean(),
    prerequisiteModuleIds: z.array(z.string()),
    state: nullableString,
    completedAt: nullableString,
    published: z.boolean(),
    itemCount: nullableNumber,
  })
  .strict();

const courseTabSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    type: nullableString,
    position: nullableNumber,
    hidden: z.boolean(),
    visibility: nullableString,
    htmlUrl: nullableString,
    externalToolId: nullableString,
  })
  .strict();

const quizSchema = z
  .object({
    id: z.string(),
    courseId: z.string(),
    title: z.string(),
    descriptionHtml: nullableString,
    descriptionText: nullableString,
    quizType: nullableString,
    dueAt: nullableString,
    unlockAt: nullableString,
    lockAt: nullableString,
    timeLimitMinutes: nullableNumber,
    allowedAttempts: nullableNumber,
    scoringPolicy: nullableString,
    pointsPossible: nullableNumber,
    questionCount: nullableNumber,
    published: z.boolean(),
    htmlUrl: nullableString,
  })
  .strict();

const discussionEntrySchema: z.ZodType<Record<string, unknown>> = z.lazy(() =>
  z
    .object({
      id: z.string(),
      topicId: z.string(),
      userId: nullableString,
      userName: nullableString,
      messageHtml: nullableString,
      messageText: nullableString,
      createdAt: nullableString,
      updatedAt: nullableString,
      readState: nullableString,
      deleted: z.boolean(),
      replies: z.array(discussionEntrySchema),
      hasMoreReplies: z.boolean(),
    })
    .strict(),
);

const discussionTopicSchema = z
  .object({
    id: z.string(),
    courseId: z.string(),
    title: z.string(),
    messageHtml: nullableString,
    messageText: nullableString,
    postedAt: nullableString,
    lastReplyAt: nullableString,
    discussionType: nullableString,
    published: z.boolean(),
    locked: z.boolean(),
    subscribed: z.boolean(),
    unreadCount: nullableNumber,
    htmlUrl: nullableString,
    authorName: nullableString,
  })
  .strict();

const pageSummarySchema = z
  .object({
    url: z.string(),
    title: z.string(),
    createdAt: nullableString,
    updatedAt: nullableString,
    published: z.boolean(),
    frontPage: z.boolean(),
    htmlUrl: nullableString,
  })
  .strict();

const coursePageSchema = pageSummarySchema.extend({
  bodyHtml: nullableString,
  bodyText: nullableString,
});

const fileSchema = z
  .object({
    id: z.string(),
    folderId: nullableString,
    displayName: z.string(),
    filename: z.string(),
    contentType: nullableString,
    size: nullableNumber,
    createdAt: nullableString,
    updatedAt: nullableString,
    modifiedAt: nullableString,
    unlockAt: nullableString,
    lockAt: nullableString,
    locked: z.boolean(),
    hidden: z.boolean(),
  })
  .strict();

const conversationParticipantSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    fullName: nullableString,
  })
  .strict();

const conversationSummaryShape = {
  id: z.string(),
  subject: z.string(),
  workflowState: nullableString,
  lastMessage: nullableString,
  lastMessageAt: nullableString,
  messageCount: z.number().int().nonnegative(),
  subscribed: z.boolean(),
  private: z.boolean(),
  starred: z.boolean(),
  contextCode: nullableString,
  contextName: nullableString,
  participants: z.array(conversationParticipantSchema),
} as const;

const conversationMessageSchema: z.ZodType<Record<string, unknown>> = z.lazy(() =>
  z
    .object({
      id: z.string(),
      createdAt: nullableString,
      authorId: nullableString,
      generated: z.boolean(),
      bodyHtml: nullableString,
      bodyText: nullableString,
      attachments: z.array(attachmentSchema),
      forwardedMessages: z.array(conversationMessageSchema),
    })
    .strict(),
);

const conversationSummarySchema = z.object(conversationSummaryShape).strict();
const conversationSchema = z
  .object({
    ...conversationSummaryShape,
    messages: z.array(conversationMessageSchema),
  })
  .strict();

const learningXAttendanceSchema = z
  .object({
    id: z.string(),
    courseId: z.string(),
    title: z.string(),
    type: nullableString,
    attendanceStatus: nullableString,
    useAttendance: z.boolean().nullable(),
    completed: z.boolean().nullable().describe("Unknown completion is null; only explicit false establishes not completed."),
    dueAt: nullableString,
    unlockAt: nullableString,
    completedAt: nullableString,
    progressSeconds: nullableNumber,
    lastAtSeconds: nullableNumber,
    required: z.boolean().nullable(),
    durationSeconds: nullableNumber,
    progressSupported: z.boolean().nullable(),
    viewerUrl: z.string(),
    moduleItemId: nullableString.optional(),
    translive: z.object({ id: z.string(), viewerUrl: z.string() }).strict().nullable().optional(),
  })
  .strict();

const learningXModuleSchema = z
  .object({
    id: z.string(),
    courseId: z.string(),
    name: z.string(),
    position: nullableNumber,
    requiredCount: nullableNumber,
    completedCount: nullableNumber,
    viewerUrl: z.string(),
    items: z.array(learningXAttendanceSchema),
  })
  .strict();

const learningXBoardSchema = z
  .object({
    id: z.string(),
    courseId: z.string(),
    title: z.string(),
    descriptionHtml: nullableString,
    descriptionText: nullableString,
    type: nullableString,
    slug: nullableString,
    position: nullableNumber,
    totalPostCount: z.number().int().nonnegative(),
    totalCommentCount: z.number().int().nonnegative(),
    unreadPostCount: z.number().int().nonnegative(),
    latestPostCreatedAt: nullableString,
    useAttachment: z.boolean(),
    useComment: z.boolean(),
    useNotice: z.boolean(),
    useReply: z.boolean(),
  })
  .strict();

const learningXBoardAttachmentSchema = z
  .object({
    id: z.string(),
    filename: z.string(),
    size: nullableNumber,
    canvasFileId: nullableString,
  })
  .strict();

const learningXBoardPostSummaryShape = {
  id: z.string(),
  courseId: z.string(),
  boardId: z.string(),
  index: nullableNumber,
  title: z.string(),
  userName: nullableString,
  attachmentCount: z.number().int().nonnegative(),
  commentCount: z.number().int().nonnegative(),
  viewCount: z.number().int().nonnegative(),
  notice: z.boolean(),
  createdAt: nullableString,
} as const;

const learningXBoardPostSummarySchema = z.object(learningXBoardPostSummaryShape).strict();
const learningXBoardPostPageSchema = z
  .object({
    page: z.number().int().positive(),
    perPage: nullableNumber,
    totalCount: nullableNumber,
    totalPages: nullableNumber,
    posts: z.array(learningXBoardPostSummarySchema),
  })
  .strict();

const learningXBoardCommentSchema = z
  .object({
    id: z.string(),
    userName: nullableString,
    contentHtml: nullableString,
    contentText: nullableString,
    createdAt: nullableString,
    secret: z.boolean(),
    attachments: z.array(learningXBoardAttachmentSchema),
  })
  .strict();

const learningXBoardPostSchema = z
  .object({
    ...learningXBoardPostSummaryShape,
    contentHtml: nullableString,
    contentText: nullableString,
    updatedAt: nullableString,
    attachments: z.array(learningXBoardAttachmentSchema),
    comments: z.array(learningXBoardCommentSchema),
  })
  .strict();

const calendarEventSchema = z
  .object({
    id: z.string(),
    type: z.string(),
    title: z.string(),
    createdAt: nullableString,
    updatedAt: nullableString,
    descriptionHtml: nullableString,
    descriptionText: nullableString,
    startAt: nullableString,
    endAt: nullableString,
    allDay: z.boolean(),
    contextCode: nullableString,
    courseId: nullableString,
    workflowState: nullableString,
    locationName: nullableString,
    htmlUrl: nullableString,
  })
  .strict();

const upcomingWorkSchema = z
  .object({
    id: z.string(),
    courseId: nullableString,
    type: z.string(),
    title: z.string(),
    date: nullableString,
    dueAt: nullableString,
    htmlUrl: nullableString,
    pointsPossible: nullableNumber,
    completed: z.boolean().nullable().describe("Submission-backed completion for coursework; grade or manual override alone is insufficient. Missing or resubmission required stays false. Non-coursework may use a manual override. Unknown is null."),
    submissionStatus: submissionStatusSchema.nullable(),
    submissionFlags: z.object({
      submitted: z.boolean().nullable(), graded: z.boolean().nullable(), needsGrading: z.boolean().nullable(),
      missing: z.boolean().nullable(), excused: z.boolean().nullable(), redoRequest: z.boolean().nullable(),
    }).strict(),
    plannerOverride: z.object({ markedComplete: z.boolean().nullable(), dismissed: z.boolean().nullable() }).strict().nullable(),
  })
  .strict();

const gradeSchema = z
  .object({
    enrollmentId: z.string(),
    courseId: z.string(),
    enrollmentState: nullableString,
    currentScore: nullableNumber,
    currentGrade: nullableString,
    finalScore: nullableNumber,
    finalGrade: nullableString,
    currentPoints: nullableNumber,
  })
  .strict();

const weeklySummarySchema = z
  .object({
    window: z
      .object({
        startAt: z.string(),
        endAt: z.string(),
      })
      .strict(),
    announcementsWindow: z.object({ startAt: z.string(), endAt: z.string() }).strict(),
    sources: z.object({
      courses: envelopeSchema(pageSchema(courseSchema)),
      upcomingWork: envelopeSchema(pageSchema(upcomingWorkSchema)),
      calendarEvents: envelopeSchema(pageSchema(calendarEventSchema)),
      announcements: envelopeSchema(pageSchema(announcementSchema)),
    }).strict(),
  })
  .strict();

const connectionStatusSchema = z
  .object({
    connected: z.literal(true),
    institution: z.enum(["hanyang", "berkeley"]),
    institutionName: z.string(),
    baseUrl: z.string(),
    profile: z
      .object({
        id: z.string(),
        name: z.string(),
        sortableName: nullableString,
        loginId: nullableString,
        primaryEmail: nullableString,
        avatarUrl: nullableString,
      })
      .strict(),
  })
  .strict();

export const canvasToolOutputSchemas = {
  connection_status: envelopeSchema(connectionStatusSchema),
  list_courses: envelopeSchema(pageSchema(courseSchema)),
  get_timetable: envelopeSchema(timetableSchema),
  get_course: envelopeSchema(courseSchema),
  list_assignments: envelopeSchema(pageSchema(assignmentSchema).extend({ coverage: z.object({
    courseId: recordId, selection: z.string(), source: z.enum(["all_assignments", "upstream_bucket"]),
    submissionIncluded: z.boolean(), queryExhausted: z.boolean().describe("This query is exhausted only; not proof that other courses or sources were checked."),
    checkedAt: z.string(),
  }).strict() }).strict()),
  get_assignment: envelopeSchema(assignmentSchema),
  list_announcements: envelopeSchema(pageSchema(announcementSchema)),
  list_modules: envelopeSchema(pageSchema(moduleSchema)),
  list_module_items: envelopeSchema(pageSchema(moduleItemSchema)),
  list_course_tabs: envelopeSchema(pageSchema(courseTabSchema)),
  list_quizzes: envelopeSchema(pageSchema(quizSchema)),
  list_discussion_topics: envelopeSchema(pageSchema(discussionTopicSchema)),
  list_discussion_entries: envelopeSchema(pageSchema(discussionEntrySchema)),
  list_discussion_replies: envelopeSchema(pageSchema(discussionEntrySchema)),
  list_pages: envelopeSchema(pageSchema(pageSummarySchema)),
  get_page: envelopeSchema(coursePageSchema),
  list_files: envelopeSchema(pageSchema(fileSchema)),
  get_file: envelopeSchema(fileSchema.extend({
    download: z.object({ url: z.string().url(), expiresAt: z.string() }).strict(),
  })),
  list_conversations: envelopeSchema(pageSchema(conversationSummarySchema)),
  get_conversation: envelopeSchema(conversationSchema),
  list_course_submissions: envelopeSchema(pageSchema(courseSubmissionSchema)),
  list_learningx_attendance: envelopeSchema(z.array(learningXAttendanceSchema)),
  get_learningx_attendance_item: envelopeSchema(learningXAttendanceSchema),
  list_learningx_modules: envelopeSchema(z.array(learningXModuleSchema)),
  list_learningx_boards: envelopeSchema(z.array(learningXBoardSchema)),
  list_learningx_board_posts: envelopeSchema(learningXBoardPostPageSchema),
  get_learningx_board_post: envelopeSchema(learningXBoardPostSchema),
  list_calendar_events: envelopeSchema(pageSchema(calendarEventSchema)),
  get_upcoming_work: envelopeSchema(pageSchema(upcomingWorkSchema)),
  get_submission_status: envelopeSchema(submissionSchema),
  get_grades: envelopeSchema(pageSchema(gradeSchema)),
  weekly_summary: envelopeSchema(weeklySummarySchema),
} as const;

export type CanvasToolName = keyof typeof canvasToolOutputSchemas;
