'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { BookOpen, BrainCircuit, Clock, Download, ExternalLink, FileText, Loader2, PlayCircle, Route } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AgentDecisionEvidence } from '@/components/a3/ui/agent-decision-evidence';
import { a3GetJson, a3PostJson, resolveA3Endpoint } from '@/lib/a3/api-client';
import type { A3ApiResponse, Course, CourseChapter, CourseMaterial, CourseMaterials, KnowledgePoint, LearningPath, StudyPlan } from '@/lib/a3/learning-types';
import { A3Card, A3Pill } from '../ui/a3-card';

export function CoursesView() {
  const [course, setCourse] = useState<Course | null>(null);
  const [materials, setMaterials] = useState<CourseMaterials | null>(null);
  const [path, setPath] = useState<LearningPath | null>(null);
  const [plan, setPlan] = useState<StudyPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    void (async () => {
      setLoading(true);
      const [list, currentPath, studyPlan] = await Promise.all([
        a3GetJson<A3ApiResponse<{ courses: Course[] }>>('/api/learning/courses/'),
        a3GetJson<A3ApiResponse<{ path: LearningPath | null }>>('/api/learning/paths/current/'),
        a3GetJson<A3ApiResponse<{ plan: StudyPlan }>>('/api/learning/study-plan/?auto=1'),
      ]);
      if (!active) return;
      if (currentPath.success && currentPath.path) setPath(currentPath.path);
      if (studyPlan.success) setPlan(studyPlan.plan);
      if (!list.success || !list.courses?.length) {
        setError(list.error || '暂无可用课程');
        setLoading(false);
        return;
      }

      const planCourseId = studyPlan.success ? studyPlan.plan.course.id : '';
      const pathCourseId = currentPath.success && currentPath.path ? currentPath.path.course.id : '';
      const selected = list.courses.find((item) => item.id === planCourseId || item.id === pathCourseId) ?? list.courses[0];
      const [detail, materialResult] = await Promise.all([
        a3GetJson<A3ApiResponse<{ course: Course }>>(`/api/learning/courses/${selected.id}/`),
        a3GetJson<A3ApiResponse<{ materials: CourseMaterials }>>(`/api/learning/courses/${selected.id}/materials/`),
      ]);
      if (!active) return;
      if (detail.success) setCourse(detail.course);
      else setError(detail.error || '课程加载失败');
      if (materialResult.success) setMaterials(materialResult.materials);
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, []);

  async function createPath() {
    if (!course) return;
    setSubmitting(true);
    setError('');
    await a3PostJson<A3ApiResponse<{ created: boolean }>>(`/api/learning/courses/${course.id}/enroll/`, {});
    const result = await a3PostJson<A3ApiResponse<{ path: LearningPath }>>('/api/learning/paths/generate/', {
      courseId: course.id,
    });
    if (!result.success) setError(result.error || '学习路径生成失败');
    else window.location.href = '/a3/learning-path';
    setSubmitting(false);
  }

  const totalPoints = course?.chapters?.reduce((sum, chapter) => sum + chapter.knowledgePoints.length, 0) ?? 0;
  const currentPathItem = resolveCurrentPathItem(path, plan);
  const currentChapter = course && currentPathItem ? findChapter(course, currentPathItem.knowledgePointId) : null;
  const currentPoint = course && currentPathItem ? findPoint(course, currentPathItem.knowledgePointId) : null;
  const currentMaterials = useMemo(
    () => materials?.chapters.find((chapter) => chapter.order === currentChapter?.order)?.materials ?? [],
    [materials, currentChapter?.order],
  );
  const todayBindings = plan?.planContext?.todayBindings ?? [];

  if (loading) {
    return (
      <div className="flex min-h-80 items-center justify-center text-slate-500">
        <Loader2 className="mr-2 size-5 animate-spin" />
        正在加载课程学习入口
      </div>
    );
  }

  if (!course) {
    return (
      <A3Card>
        <p className="text-sm text-rose-600">{error || '课程不存在'}</p>
      </A3Card>
    );
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-5 xl:grid-cols-[1fr_380px]">
        <A3Card>
          <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
            <div>
              <A3Pill tone="blue">课程学习入口</A3Pill>
              <h1 className="mt-3 text-2xl font-semibold tracking-normal text-slate-950">{course.title}</h1>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
                先学当前路径节点，再打开对应章节资料，练习和 AI 课堂会沿用同一条学习主线。
              </p>
            </div>
            <Button onClick={createPath} disabled={submitting} className="bg-blue-600 hover:bg-blue-700">
              {submitting ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Route className="mr-2 size-4" />}
              {course.enrolled ? '按当前画像重排路径' : '加入课程并生成路径'}
            </Button>
          </div>

          <div className="mt-5 grid gap-5 lg:grid-cols-[1fr_320px]">
            <div className="rounded-xl border border-blue-100 bg-blue-50 p-4">
              <div className="text-xs font-semibold text-blue-700">当前该学</div>
              <div className="mt-2 text-xl font-semibold text-blue-950">{currentPoint?.title ?? currentPathItem?.title ?? '等待生成学习节点'}</div>
              <div className="mt-2 text-sm leading-6 text-blue-800">
                {currentChapter ? `第 ${currentChapter.order} 章 · ${currentChapter.title}` : course.edition || '当前课程'} ·{' '}
                {currentPoint?.estimatedMinutes ?? currentPathItem?.estimatedMinutes ?? plan?.dailyMinutes ?? 0} 分钟
              </div>
              <p className="mt-3 text-sm leading-6 text-blue-900">{currentPathItem?.reason ?? '系统会根据画像、诊断和错题，把课程章节排到学习路径中。'}</p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Metric icon={BookOpen} label="章节" value={`${course.chapters?.length ?? 0} 章`} />
              <Metric icon={FileText} label="真实资料" value={`${materials?.summary.total ?? 0} 个`} />
              <Metric icon={Clock} label="知识点" value={`${totalPoints} 个`} />
              <Metric icon={BrainCircuit} label="今日绑定" value={`${todayBindings.length} 项`} />
            </div>
          </div>
        </A3Card>

        <AgentDecisionEvidence
          compact
          title="课程入口决策证据"
          items={[
            {
              agent: 'ProfileAgent',
              input: `${plan?.explanation?.profileSignals.learningGoals?.[0] ?? '当前课程目标'}，每日 ${plan?.dailyMinutes ?? path?.rationale.dailyStudyTime ?? 0} 分钟`,
              output: `优先呈现 ${currentChapter ? `第 ${currentChapter.order} 章` : '当前路径章节'} 的真实资料`,
              evidence: `薄弱点：${plan?.explanation?.profileSignals.weakPoints?.slice(0, 3).join('、') || path?.rationale.weakPoints?.slice(0, 3).join('、') || '暂无'}`,
            },
            {
              agent: 'PlannerAgent',
              input: currentPathItem?.title ?? '等待路径节点',
              output: currentMaterials.length ? `已匹配 ${currentMaterials.length} 个章节资料` : '未匹配到章节资料，显示全课程教材和知识库入口',
              evidence: materials?.schemaVersion ?? 'a3.course-materials.v1',
            },
          ]}
        />
      </div>

      {error && <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>}

      <section className="grid gap-5 xl:grid-cols-[1fr_360px]">
        <A3Card title="当前章节资料" subtitle="来自后端知识库的真实课件，不再使用前端写死目录。">
          {currentMaterials.length ? (
            <div className="grid gap-3 md:grid-cols-2">
              {currentMaterials.map((material) => (
                <MaterialCard key={material.id} material={material} primary />
              ))}
            </div>
          ) : (
            <EmptyMaterials chapterTitle={currentChapter?.title} />
          )}
          <div className="mt-4 grid gap-3 md:grid-cols-3">
            <ActionCard icon={PlayCircle} title="AI 课堂" detail="围绕当前节点讲解" href="/a3/classroom" />
            <ActionCard icon={FileText} title="对应练习" detail="答题后回写错题和掌握度" href="/a3/assessment" />
            <ActionCard icon={BookOpen} title="知识库检索" detail="查找更多来源片段" href="/a3/knowledge-base" />
          </div>
        </A3Card>

        <A3Card title="全课程资料">
          <div className="space-y-3">
            {(materials?.courseWideMaterials ?? []).map((material) => (
              <MaterialCard key={material.id} material={material} compact />
            ))}
            {!materials?.courseWideMaterials.length && <div className="rounded-lg bg-slate-50 p-3 text-sm text-slate-500">暂无全课程教材。</div>}
            <Button asChild size="sm" variant="outline">
              <Link href="/a3/today">回到今日学习</Link>
            </Button>
          </div>
        </A3Card>
      </section>

      <A3Card title="九章课程资料" subtitle="每章显示真实课件状态，点击即可打开或下载。">
        <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
          {course.chapters?.map((chapter) => {
            const chapterMaterials = materials?.chapters.find((item) => item.order === chapter.order)?.materials ?? [];
            const isCurrentChapter = chapter.id === currentChapter?.id;
            return (
              <div key={chapter.id} className={`rounded-xl border p-4 ${isCurrentChapter ? 'border-blue-200 bg-blue-50' : 'border-slate-200 bg-white'}`}>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold text-slate-950">第 {chapter.order} 章 · {chapter.title}</div>
                    <div className="mt-1 text-xs text-slate-500">{chapter.estimatedMinutes} 分钟 · {chapter.knowledgePoints.length} 个知识点</div>
                  </div>
                  <A3Pill tone={isCurrentChapter ? 'blue' : chapterMaterials.length ? 'green' : 'slate'}>
                    {isCurrentChapter ? '当前' : chapterMaterials.length ? '有资料' : '待补充'}
                  </A3Pill>
                </div>
                <div className="mt-4 space-y-2">
                  {chapterMaterials.map((material) => (
                    <MaterialRow key={material.id} material={material} />
                  ))}
                  {!chapterMaterials.length && <div className="rounded-lg bg-slate-50 px-3 py-3 text-sm text-slate-500">这一章暂无课件。</div>}
                </div>
              </div>
            );
          })}
        </div>
      </A3Card>
    </div>
  );
}

type CurrentPathItem = {
  title: string;
  chapter?: string;
  knowledgePointId: string;
  reason?: string;
  estimatedMinutes?: number;
};

function resolveCurrentPathItem(path: LearningPath | null, plan: StudyPlan | null): CurrentPathItem | null {
  const pathItem = path?.items.find((item) => item.status === 'current') ?? path?.items.find((item) => item.status !== 'completed');
  if (pathItem) {
    return {
      title: pathItem.knowledgePoint.title,
      chapter: pathItem.knowledgePoint.chapter.title,
      knowledgePointId: pathItem.knowledgePoint.id,
      reason: pathItem.reason,
      estimatedMinutes: pathItem.estimatedMinutes,
    };
  }
  const planItem = plan?.planContext?.learningPath.currentItem;
  if (!planItem) return null;
  return {
    title: planItem.title,
    chapter: planItem.chapter,
    knowledgePointId: planItem.knowledgePointId,
    reason: planItem.reason,
    estimatedMinutes: planItem.estimatedMinutes,
  };
}

function findChapter(course: Course, knowledgePointId: string): CourseChapter | null {
  return course.chapters?.find((chapter) => chapter.knowledgePoints.some((point) => point.id === knowledgePointId)) ?? null;
}

function findPoint(course: Course, knowledgePointId: string): KnowledgePoint | null {
  for (const chapter of course.chapters ?? []) {
    const point = chapter.knowledgePoints.find((item) => item.id === knowledgePointId);
    if (point) return point;
  }
  return null;
}

function Metric({ icon: Icon, label, value }: { icon: typeof BookOpen; label: string; value: string }) {
  return (
    <div className="rounded-lg bg-slate-50 p-4">
      <Icon className="size-5 text-blue-600" />
      <div className="mt-2 text-xs text-slate-500">{label}</div>
      <div className="mt-1 text-lg font-semibold text-slate-950">{value}</div>
    </div>
  );
}

function ActionCard({ icon: Icon, title, detail, href }: { icon: typeof PlayCircle; title: string; detail: string; href: string }) {
  return (
    <Link href={href} className="rounded-xl border border-slate-200 bg-white p-4 transition-colors hover:border-blue-300 hover:bg-blue-50">
      <Icon className="size-5 text-blue-600" />
      <div className="mt-3 text-sm font-semibold text-slate-950">{title}</div>
      <p className="mt-1 text-xs leading-5 text-slate-500">{detail}</p>
    </Link>
  );
}

function MaterialCard({ material, primary = false, compact = false }: { material: CourseMaterial; primary?: boolean; compact?: boolean }) {
  const openHref = materialOpenHref(material);
  const openInNewTab = !isPptxMaterial(material);
  return (
    <div className={`rounded-xl border border-slate-200 bg-white ${compact ? 'p-3' : 'p-4'}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <FileText className="size-4 shrink-0 text-blue-600" />
            <div className="truncate text-sm font-semibold text-slate-950">{material.name}</div>
          </div>
          <div className="mt-2 flex flex-wrap gap-2 text-xs text-slate-500">
            <span>{material.type}</span>
            <span>{formatFileSize(material.size)}</span>
            <span>{statusText(material)}</span>
          </div>
        </div>
        {primary && <A3Pill tone={material.isIndexed ? 'green' : 'slate'}>{material.isIndexed ? '已索引' : '可打开'}</A3Pill>}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button asChild size="sm" variant={primary ? 'default' : 'outline'} className={primary ? 'bg-blue-600 hover:bg-blue-700' : undefined}>
          <a href={openHref} target={openInNewTab ? '_blank' : undefined} rel={openInNewTab ? 'noreferrer' : undefined}>
            <ExternalLink className="mr-2 size-3.5" />
            {isPptxMaterial(material) ? '预览课件' : '打开资料'}
          </a>
        </Button>
        <Button asChild size="sm" variant="ghost">
          <a href={resolveA3Endpoint(material.downloadUrl.replace('disposition=inline', ''))} target="_blank" rel="noreferrer">
            <Download className="mr-2 size-3.5" />
            下载
          </a>
        </Button>
      </div>
    </div>
  );
}

function MaterialRow({ material }: { material: CourseMaterial }) {
  const openHref = materialOpenHref(material);
  const openInNewTab = !isPptxMaterial(material);
  return (
    <a
      href={openHref}
      target={openInNewTab ? '_blank' : undefined}
      rel={openInNewTab ? 'noreferrer' : undefined}
      className="flex items-center justify-between gap-3 rounded-lg bg-slate-50 px-3 py-3 text-sm transition-colors hover:bg-blue-50"
    >
      <span className="min-w-0 truncate font-medium text-slate-800">{material.name}</span>
      <span className="shrink-0 text-xs text-slate-500">{material.type}</span>
    </a>
  );
}

function EmptyMaterials({ chapterTitle }: { chapterTitle?: string }) {
  return (
    <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-5">
      <div className="text-sm font-semibold text-slate-900">{chapterTitle ? `${chapterTitle} 暂无课件` : '当前章节暂无课件'}</div>
      <p className="mt-2 text-sm leading-6 text-slate-500">可以先看全课程教材，或到知识库上传该章节 PPT/PDF 后重新解析。</p>
      <Button asChild size="sm" variant="outline" className="mt-4">
        <Link href="/a3/knowledge-base">去知识库上传</Link>
      </Button>
    </div>
  );
}

function formatFileSize(size: number) {
  if (!Number.isFinite(size) || size <= 0) return '未知大小';
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(size / 1024))} KB`;
}

function statusText(material: CourseMaterial) {
  if (material.isIndexed) return '已进入检索';
  if (material.isParsed) return '已解析';
  if (material.status === 'uploaded') return '待解析';
  return material.status;
}

function isPptxMaterial(material: CourseMaterial) {
  return material.type.toUpperCase() === 'PPTX' || material.name.toLowerCase().endsWith('.pptx');
}

function materialOpenHref(material: CourseMaterial) {
  if (isPptxMaterial(material)) return `/a3/course-materials/${material.id}`;
  return resolveA3Endpoint(material.downloadUrl);
}
