import { z } from "zod";
import type { CourseOption } from "../shared/courses.js";

const studyCourseSchema = z
  .object({
    id: z.string().min(1),
    code: z.string(),
    name: z.string().min(1),
    term: z.string().nullable(),
    folderName: z.string().min(1),
    label: z.string().min(1),
    status: z.enum(["active", "archived"]),
    source: z.literal("canvas"),
    startAt: z.string().nullable(),
    endAt: z.string().nullable(),
    lastSeenAt: z.string().datetime(),
    archivedAt: z.string().datetime().nullable()
  })
  .strict();

const studyCoursesResponseSchema = z
  .object({
    courses: z.array(studyCourseSchema),
    syncedAt: z.string().datetime(),
    stale: z.boolean()
  })
  .strict();

export interface StudyCoursesResult {
  courses: CourseOption[];
  syncedAt: string;
  stale: boolean;
}

export interface StudyCourseClient {
  listCourses(options: { includeArchived: boolean; refresh: boolean }): Promise<StudyCoursesResult>;
}

export function createStudyCourseClient({
  baseUrl,
  serviceToken,
  fetchImpl = fetch
}: {
  baseUrl: string;
  serviceToken: string;
  fetchImpl?: typeof fetch;
}): StudyCourseClient {
  const normalizedBaseUrl = normalizeStudyApiUrl(baseUrl);
  if (!serviceToken.trim()) {
    throw new Error("STUDY_SERVICE_TOKEN is required");
  }

  return {
    async listCourses({ includeArchived, refresh }) {
      const url = new URL("/internal/lecture/courses", normalizedBaseUrl);
      url.searchParams.set("include_archived", String(includeArchived));
      url.searchParams.set("refresh", String(refresh));
      const response = await fetchImpl(url, {
        headers: {
          Authorization: `Bearer ${serviceToken}`,
          Accept: "application/json"
        },
        redirect: "error",
        signal: AbortSignal.timeout(12_000)
      });

      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`Study course request failed with status ${response.status}`);
      }

      const parsed = studyCoursesResponseSchema.safeParse(await readJsonWithLimit(response, 1_000_000));
      if (!parsed.success) {
        throw new Error("Study course response did not match the expected contract");
      }

      return {
        courses: parsed.data.courses.map((course) => ({
          id: course.id,
          code: course.code,
          name: course.name,
          term: course.term ?? "",
          folderName: course.folderName,
          label: course.label,
          source: "canvas" as const,
          workflowState: course.status,
          startAt: course.startAt,
          endAt: course.endAt,
          isArchived: course.status === "archived",
          lastSeenAt: course.lastSeenAt,
          archivedAt: course.archivedAt
        })),
        syncedAt: parsed.data.syncedAt,
        stale: parsed.data.stale
      };
    }
  };
}

async function readJsonWithLimit(response: Response, maximumBytes: number): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("Study course response exceeded the allowed size");
  }
  if (!response.body) {
    throw new Error("Study course response did not include a body");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error("Study course response exceeded the allowed size");
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(merged));
  } catch {
    throw new Error("Study course response was not valid JSON");
  }
}

function normalizeStudyApiUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("STUDY_API_URL must use http or https");
  }
  url.username = "";
  url.password = "";
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url;
}
