export interface CourseOption {
  id: string;
  code: string;
  name: string;
  term: string;
  folderName: string;
  label: string;
}

export const DAILY_COURSE_ID = "daily";

export const COURSES: CourseOption[] = [
  {
    id: DAILY_COURSE_ID,
    code: "daily",
    name: "日常 / 不选课程",
    term: "",
    folderName: "daily",
    label: "日常 / 不选课程"
  },
  createCourse("202610HY20215", "아카데믹한국어듣기말하기"),
  createCourse("202610HY20225", "아카데믹한국어읽기쓰기"),
  createCourse("202610HY20235", "한국어듣기말하기"),
  createCourse("202610HY20245", "한국어읽기쓰기"),
  createCourse("202610HY24542", "미디어제작의이해"),
  createCourse("202610HY25889", "커뮤니케이션학의이해")
];

export function findCourseById(courseId: string): CourseOption | undefined {
  return COURSES.find((course) => course.id === courseId);
}

function createCourse(code: string, name: string): CourseOption {
  const term = "2026년 1학기";
  return {
    id: code,
    code,
    name,
    term,
    folderName: `${code}_${name}`,
    label: `${code}_${name}`
  };
}
