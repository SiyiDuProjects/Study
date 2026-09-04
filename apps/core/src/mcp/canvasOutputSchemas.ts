import { z } from "zod";

const nullableString = z.string().nullable();
const nullableNumber = z.number().nullable();

const canvasErrorSchema = z
  .object({
    code: z.enum([
      "configuration_error",
      "invalid_argument",
      "authentication_failed",
      "permission_denied",
      "not_found",
      "rate_limited",
      "canvas_error",
      "upstream_error",
      "timeout",
      "network_error",
      "invalid_response",
      "unsafe_pagination",
    ]),
    message: z.string(),
    status: z.number().int().nullable(),
    retryable: z.boolean(),
    requestId: nullableString,
    retryAfterSeconds: z.number().nonnegative().nullable(),
  })
  .strict();

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
  assignmentId: z.string(),
  courseId: z.string(),
  status: submissionStatusSchema,
  workflowState: nullableString,
  submittedAt: nullableString,
  gradedAt: nullableString,
  score: nullableNumber,
  grade: nullableString,
  attempt: nullableNumber,
  late: z.boolean(),
  missing: z.boolean(),
  excused: z.boolean(),
  secondsLate: z.number(),
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
    id: z.string(),
    courseId: z.string(),
    name: z.string(),
    descriptionHtml: nullableString,
    descriptionText: nullableString,
    dueAt: nullableString,
    unlockAt: nullableString,
    lockAt: nullableString,
    pointsPossible: nullableNumber,
    position: nullableNumber,
    published: z.boolean(),
    workflowState: nullableString,
    submissionTypes: z.array(z.string()),
    allowedExtensions: z.array(z.string()),
    hasSubmittedSubmissions: z.boolean(),
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
    items: z.array(moduleItemSchema),
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

const pageSchema = pageSummarySchema.extend({
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
    useAttendance: z.boolean(),
    completed: z.boolean(),
    dueAt: nullableString,
    unlockAt: nullableString,
    completedAt: nullableString,
    progressSeconds: nullableNumber,
    lastAtSeconds: nullableNumber,
    required: z.boolean(),
    durationSeconds: nullableNumber,
    progressSupported: z.boolean().nullable(),
    viewerUrl: z.string(),
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
    completed: z.boolean(),
    submissionStatus: submissionStatusSchema.nullable(),
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
    courses: z.array(courseSchema),
    upcomingWork: z.array(upcomingWorkSchema),
    calendarEvents: z.array(calendarEventSchema),
    announcements: z.array(announcementSchema),
    counts: z
      .object({
        courses: z.number().int().nonnegative(),
        upcomingWork: z.number().int().nonnegative(),
        incompleteWork: z.number().int().nonnegative(),
        calendarEvents: z.number().int().nonnegative(),
        announcements: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

const ENVELOPE_BRANCHES = [
  {
    properties: {
      ok: { const: true },
      result: { not: { type: "null" } },
      error: { type: "null" },
    },
    required: ["ok", "result", "error"],
  },
  {
    properties: {
      ok: { const: false },
      result: { type: "null" },
      error: { not: { type: "null" } },
    },
    required: ["ok", "result", "error"],
  },
] as const;

function envelopeSchema(resultSchema: z.ZodType<unknown>) {
  return z
    .object({
      ok: z.boolean(),
      result: resultSchema.nullable(),
      error: canvasErrorSchema.nullable(),
    })
    .strict()
    .meta({ oneOf: ENVELOPE_BRANCHES })
    .superRefine((envelope, context) => {
      const validSuccess = envelope.ok && envelope.result !== null && envelope.error === null;
      const validError = !envelope.ok && envelope.result === null && envelope.error !== null;
      if (!validSuccess && !validError) {
        context.addIssue({
          code: "custom",
          message: "Canvas tool envelope success/error fields are inconsistent.",
        });
      }
    });
}

const connectionStatusSchema = z
  .object({
    connected: z.literal(true),
    institution: z.literal("hanyang"),
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
  list_courses: envelopeSchema(z.array(courseSchema)),
  get_timetable: envelopeSchema(timetableSchema),
  get_course: envelopeSchema(courseSchema),
  list_assignments: envelopeSchema(z.array(assignmentSchema)),
  get_assignment: envelopeSchema(assignmentSchema),
  list_announcements: envelopeSchema(z.array(announcementSchema)),
  list_modules: envelopeSchema(z.array(moduleSchema)),
  list_course_tabs: envelopeSchema(z.array(courseTabSchema)),
  list_quizzes: envelopeSchema(z.array(quizSchema)),
  list_discussion_topics: envelopeSchema(z.array(discussionTopicSchema)),
  list_discussion_entries: envelopeSchema(z.array(discussionEntrySchema)),
  list_pages: envelopeSchema(z.array(pageSummarySchema)),
  get_page: envelopeSchema(pageSchema),
  list_files: envelopeSchema(z.array(fileSchema)),
  get_file: envelopeSchema(fileSchema),
  list_conversations: envelopeSchema(z.array(conversationSummarySchema)),
  get_conversation: envelopeSchema(conversationSchema),
  list_course_submissions: envelopeSchema(z.array(courseSubmissionSchema)),
  list_learningx_attendance: envelopeSchema(z.array(learningXAttendanceSchema)),
  get_learningx_attendance_item: envelopeSchema(learningXAttendanceSchema),
  list_learningx_modules: envelopeSchema(z.array(learningXModuleSchema)),
  list_learningx_boards: envelopeSchema(z.array(learningXBoardSchema)),
  list_learningx_board_posts: envelopeSchema(learningXBoardPostPageSchema),
  get_learningx_board_post: envelopeSchema(learningXBoardPostSchema),
  list_calendar_events: envelopeSchema(z.array(calendarEventSchema)),
  get_upcoming_work: envelopeSchema(z.array(upcomingWorkSchema)),
  get_submission_status: envelopeSchema(submissionSchema),
  get_grades: envelopeSchema(z.array(gradeSchema)),
  weekly_summary: envelopeSchema(weeklySummarySchema),
} as const;

export type CanvasToolName = keyof typeof canvasToolOutputSchemas;
