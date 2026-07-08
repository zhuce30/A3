import type { TeacherWorkbenchStudent } from './teacher-types';

export type TeacherResourcePackFilter = 'all' | 'unconverted' | 'converted';

export function buildTeacherResourcePackFilter(students: TeacherWorkbenchStudent[], filter: TeacherResourcePackFilter) {
  const counts = students.reduce(
    (total, student) => {
      const converted = (student.resourcePack?.totalRuns ?? 0) > 0;
      total.all += 1;
      if (converted) total.converted += 1;
      else total.unconverted += 1;
      return total;
    },
    { all: 0, unconverted: 0, converted: 0 },
  );
  const filtered = students.filter((student) => {
    const converted = (student.resourcePack?.totalRuns ?? 0) > 0;
    if (filter === 'converted') return converted;
    if (filter === 'unconverted') return !converted;
    return true;
  });
  return {
    counts,
    students: filtered,
    emptyText:
      filter === 'converted'
        ? '暂无已转化资源包的学生。'
        : filter === 'unconverted'
          ? '当前没有未完成资源包的学生。'
          : '暂无学生数据。',
  };
}
