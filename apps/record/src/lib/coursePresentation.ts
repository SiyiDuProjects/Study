export function displayCourseName(name?: string) {
  return name?.replace(/^\d{6}HY\d+_/, "") || "正在读取课程";
}
