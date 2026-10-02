import { envelopeSchema } from "./contracts.js";

import {
  getLectureSessionResponseSchema,
  listLectureSessionsResponseSchema,
  searchLectureTranscriptsResponseSchema,
} from "../lecture/types.js";

export const lectureToolOutputSchemas = {
  list_lecture_sessions: envelopeSchema(listLectureSessionsResponseSchema),
  get_lecture_transcript: envelopeSchema(getLectureSessionResponseSchema),
  search_lecture_transcripts: envelopeSchema(searchLectureTranscriptsResponseSchema),
} as const;

export type LectureToolName = keyof typeof lectureToolOutputSchemas;
