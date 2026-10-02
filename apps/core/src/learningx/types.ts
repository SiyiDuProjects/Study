export type LearningXFeature = "attendance" | "modules" | "board";

export interface LearningXAttendanceItem {
  id: string;
  courseId: string;
  title: string;
  type: string | null;
  attendanceStatus: string | null;
  useAttendance: boolean | null;
  completed: boolean | null;
  dueAt: string | null;
  unlockAt: string | null;
  completedAt: string | null;
  progressSeconds: number | null;
  lastAtSeconds: number | null;
  required: boolean | null;
  durationSeconds: number | null;
  progressSupported: boolean | null;
  viewerUrl: string;
  moduleItemId?: string | null;
  translive?: { id: string; viewerUrl: string } | null;
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

export interface LearningXBoard {
  id: string;
  courseId: string;
  title: string;
  descriptionHtml: string | null;
  descriptionText: string | null;
  type: string | null;
  slug: string | null;
  position: number | null;
  totalPostCount: number;
  totalCommentCount: number;
  unreadPostCount: number;
  latestPostCreatedAt: string | null;
  useAttachment: boolean;
  useComment: boolean;
  useNotice: boolean;
  useReply: boolean;
}

export interface LearningXBoardAttachment {
  id: string;
  filename: string;
  size: number | null;
  canvasFileId: string | null;
}

export interface LearningXBoardPostSummary {
  id: string;
  courseId: string;
  boardId: string;
  index: number | null;
  title: string;
  userName: string | null;
  attachmentCount: number;
  commentCount: number;
  viewCount: number;
  notice: boolean;
  createdAt: string | null;
}

export interface LearningXBoardPostPage {
  page: number;
  perPage: number | null;
  totalCount: number | null;
  totalPages: number | null;
  posts: LearningXBoardPostSummary[];
}

export interface LearningXBoardComment {
  id: string;
  userName: string | null;
  contentHtml: string | null;
  contentText: string | null;
  createdAt: string | null;
  secret: boolean;
  attachments: LearningXBoardAttachment[];
}

export interface LearningXBoardPost extends LearningXBoardPostSummary {
  contentHtml: string | null;
  contentText: string | null;
  updatedAt: string | null;
  attachments: LearningXBoardAttachment[];
  comments: LearningXBoardComment[];
}
