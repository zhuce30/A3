'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  Database,
  Loader2,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  Users,
} from 'lucide-react';
import Link from 'next/link';
import { useA3CurrentUser } from '@/components/a3/auth/a3-auth-gate';
import { Button } from '@/components/ui/button';
import { a3GetJson, a3PostJson } from '@/lib/a3/api-client';
import {
  formatArtifactTimestamp,
  sortOpenMAICArtifactHistory,
  teacherArtifactCountsToSummary,
} from '@/lib/a3/openmaic-artifact-history';
import { buildTeacherResourcePackFilter, type TeacherResourcePackFilter } from '@/lib/a3/teacher-resource-pack-filter';
import type { TeacherDistributionItem, TeacherTask, TeacherWorkbench, TeacherWorkbenchStudent } from '@/lib/a3/teacher-types';
import { cn } from '@/lib/utils';
import { A3Card, A3Pill } from '../ui/a3-card';
import { MetricGrid } from '../ui/metric-card';
import { QuestionBankReviewPanel } from './question-bank-review-panel';

type TeacherWorkbenchResponse = {
  success: boolean;
  error?: string;
  workbench: TeacherWorkbench;
};

type ExecuteTaskResponse = {
  success: boolean;
  error?: string;
  result?: {
    taskType: TeacherTask['type'];
    createdNotifications: number;
    title: string;
    targetStudentId?: string;
    targetStudentName?: string;
    actionUrl?: string;
  };
};

type InterventionEvidence = NonNullable<ExecuteTaskResponse['result']>;

const toneBar: Record<TeacherDistributionItem['tone'], string> = {
  green: 'bg-emerald-500',
  blue: 'bg-blue-500',
  orange: 'bg-orange-500',
  red: 'bg-rose-500',
};

const riskTone = {
  low: 'green',
  medium: 'orange',
  high: 'red',
} as const;

const riskLabel = {
  low: '低风险',
  medium: '需跟进',
  high: '需干预',
} as const;

const actionTone = {
  intervention: 'red',
  assessment: 'orange',
  notification: 'blue',
} as const;

export function TeacherWorkbenchView() {
  const user = useA3CurrentUser();
  const [workbench, setWorkbench] = useState<TeacherWorkbench | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [executingTask, setExecutingTask] = useState<TeacherTask['type'] | null>(null);
  const [executingStudentId, setExecutingStudentId] = useState<string | null>(null);
  const [interventionEvidence, setInterventionEvidence] = useState<InterventionEvidence | null>(null);
  const [resourcePackFilter, setResourcePackFilter] = useState<TeacherResourcePackFilter>('all');

  const loadWorkbench = useCallback(async () => {
    setLoading(true);
    const result = await a3GetJson<TeacherWorkbenchResponse>('/api/learning/teacher/workbench/');
    setLoading(false);
    if (!result.success) {
      setMessage(result.error ?? '教师工作台加载失败');
      return;
    }
    setWorkbench(result.workbench);
    setMessage('');
  }, []);

  async function executeTask(type: TeacherTask['type']) {
    setExecutingTask(type);
    const result = await a3PostJson<ExecuteTaskResponse>('/api/learning/teacher/tasks/execute/', { type });
    setExecutingTask(null);
    if (!result.success || !result.result) {
      setMessage(result.error ?? '任务执行失败');
      return;
    }
    setInterventionEvidence(result.result);
    const notifCount = result.result.createdNotifications;
    const notifText = notifCount > 0 ? `已通知 ${notifCount} 名学生` : '干预已记录，未重复创建通知';
    setMessage(`${result.result.title}，${notifText}`);
  }

  async function executeStudentTask(student: TeacherWorkbenchStudent) {
    const taskType = student.interventionAction?.type ?? student.prescription?.primaryAction.type ?? 'notification';
    const title = student.prescription?.title ?? '学习提醒';
    const reason = student.prescription?.reason ?? '请按当前学习路径继续完成今日任务。';
    setExecutingStudentId(student.id);
    const result = await a3PostJson<ExecuteTaskResponse>('/api/learning/teacher/tasks/execute/', {
      type: taskType,
      studentId: student.id,
      message: `${title}：${reason}`,
    });
    setExecutingStudentId(null);
    if (!result.success || !result.result) {
      setMessage(result.error ?? '定制干预任务下发失败');
      return;
    }
    setInterventionEvidence(result.result);
    setMessage(`已向 ${result.result.targetStudentName ?? student.name} 下发定制任务`);
  }

  const priorityStudents = useMemo(() => {
    const students = workbench?.students ?? [];
    return [...students]
      .sort((left, right) => {
        const riskWeight = { high: 0, medium: 1, low: 2 };
        return riskWeight[left.riskLevel] - riskWeight[right.riskLevel] || left.progress - right.progress;
      })
      .slice(0, 4);
  }, [workbench?.students]);
  const resourcePackStudentView = buildTeacherResourcePackFilter(workbench?.students ?? [], resourcePackFilter);

  useEffect(() => {
    if (user?.role !== 'teacher' && user?.role !== 'admin') return;
    const timer = window.setTimeout(() => {
      void loadWorkbench();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadWorkbench, user?.role]);

  if (user?.role !== 'teacher' && user?.role !== 'admin') {
    return (
      <A3Card>
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="flex size-14 items-center justify-center rounded-2xl bg-amber-50 text-amber-600">
            <ShieldAlert className="size-7" />
          </div>
          <h1 className="mt-5 text-2xl font-semibold text-[var(--a3-text)]">当前账号没有教师工作台权限</h1>
          <p className="mt-2 max-w-md text-sm text-[var(--a3-text-muted)]">
            教师工作台用于班级学情管理、资源效果分析和教学任务下发。请切换教师账号，或返回学习首页。
          </p>
          <div className="mt-6 flex gap-3">
            <Button asChild variant="outline">
              <Link href="/a3/dashboard">返回首页</Link>
            </Button>
            <Button asChild className="bg-blue-600 hover:bg-blue-700">
              <Link href="/a3/login?switch=1">切换账号</Link>
            </Button>
          </div>
        </div>
      </A3Card>
    );
  }

  return (
    <div className="min-w-0 space-y-5" data-testid="a3-teacher-workbench">
      <A3Card>
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <A3Pill tone="blue">教师空间</A3Pill>
            <h1 className="mt-3 text-2xl font-semibold tracking-normal text-[var(--a3-text)]">操作系统教学工作台</h1>
            <p className="mt-2 text-sm text-[var(--a3-text-muted)]">
              汇总班级学情、知识库质量、待干预学生和 OpenMAIC 资源效果，帮助教师把干预动作落到学生通知与学习计划中。
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" disabled={loading} onClick={() => void loadWorkbench()}>
              {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
              刷新
            </Button>
            <Button disabled={executingTask === 'notification'} onClick={() => executeTask('notification')} className="bg-blue-600 hover:bg-blue-700">
              {executingTask === 'notification' && <Loader2 className="size-4 animate-spin" />}
              发布学习任务
            </Button>
          </div>
        </div>
      </A3Card>

      {message && <div data-testid="a3-teacher-message" className="rounded-lg bg-blue-50 px-3 py-2 text-sm text-blue-700">{message}</div>}

      {interventionEvidence && (
        <A3Card
          title="干预证据链"
          subtitle="本卡片来自教师任务接口返回值，展示任务是否真正写入学生通知系统。"
          action={<A3Pill tone={interventionEvidence.createdNotifications > 0 ? 'green' : 'orange'}>{interventionEvidence.createdNotifications} notifications</A3Pill>}
        >
          <div className="grid gap-3 md:grid-cols-4" data-testid="a3-teacher-intervention-evidence">
            <EvidenceMetric label="通知回流" value={`${interventionEvidence.createdNotifications} 条`} detail="写入学生通知中心" />
            <EvidenceMetric label="目标学生" value={interventionEvidence.targetStudentName ?? '全班'} detail={interventionEvidence.targetStudentId ? '定向干预' : '班级任务'} />
            <EvidenceMetric label="任务类型" value={interventionEvidence.taskType} detail={interventionEvidence.title} />
            <div className="rounded-xl border border-blue-200 bg-blue-50 p-4">
              <div className="text-xs text-blue-700">学生侧入口</div>
              <div className="mt-2 text-sm font-semibold text-blue-950">{interventionEvidence.actionUrl ?? '/a3/notifications'}</div>
              <Button asChild size="sm" className="mt-3 bg-blue-600 hover:bg-blue-700">
                <Link data-testid="a3-teacher-intervention-notification-link" href="/a3/notifications">查看学生通知</Link>
              </Button>
            </div>
          </div>
        </A3Card>
      )}

      <MetricGrid metrics={workbench?.metrics ?? []} />

      {workbench?.resourcePackSummary && (
        <ResourcePackSummaryCard
          summary={workbench.resourcePackSummary}
          executing={executingTask === 'resource_pack_reminder'}
          onExecute={() => executeTask('resource_pack_reminder')}
        />
      )}

      {workbench?.resourcePackSummary && <OpenMAICArtifactEffectCardV2 summary={workbench.resourcePackSummary} />}

      <QuestionBankReviewPanel />

      <div className="grid min-w-0 gap-5 xl:grid-cols-[minmax(0,1fr)_400px]">
        <A3Card className="min-w-0" title="班级学情概览" action={loading ? <Loader2 className="size-4 animate-spin text-blue-600" /> : undefined}>
          <div className="grid gap-4 md:grid-cols-2">
            <DistributionPanel workbench={workbench} />
            <KnowledgeBasePanel workbench={workbench} />
          </div>

          <StudentTable students={resourcePackStudentView.students} />
          <ResourcePackStudentFilter
            filter={resourcePackFilter}
            counts={resourcePackStudentView.counts}
            emptyText={resourcePackStudentView.emptyText}
            students={resourcePackStudentView.students}
            onChange={setResourcePackFilter}
          />
        </A3Card>

        <div className="min-w-0 space-y-5">
          <RiskStudentsCard students={workbench?.students ?? []} />
          <A3Card title="学生学习处方">
            <div className="space-y-3">
              {priorityStudents.map((student) => (
                <PrescriptionCard
                  key={student.id}
                  student={student}
                  executing={executingStudentId === student.id}
                  onExecute={() => executeStudentTask(student)}
                />
              ))}
              {!loading && priorityStudents.length === 0 && (
                <div className="rounded-xl bg-[var(--a3-surface-muted)] p-4 text-sm text-[var(--a3-text-muted)]">
                  暂无学生学情数据。完成演示数据初始化后可查看个性化干预建议。
                </div>
              )}
            </div>
          </A3Card>
        </div>
      </div>

      <div
        className="grid gap-5 xl:grid-cols-2"
        data-testid="a3-teacher-homepage-evidence"
      >
        <WeakPointsCard weakPoints={workbench?.weakPoints ?? []} showEmpty={!loading} />
        <A3Card title="课堂任务队列">
          <div className="space-y-3">
            {(workbench?.tasks ?? []).map((task, index) => (
              <TaskRow key={`${task.type}-${task.title}-${index}`} task={task} executing={executingTask === task.type} onExecute={() => executeTask(task.type)} />
            ))}
            {!loading && !(workbench?.tasks ?? []).length && (
              <div data-testid="a3-teacher-tasks-empty" className="rounded-xl bg-[var(--a3-surface-muted)] p-4 text-sm text-[var(--a3-text-muted)]">
                当前没有待执行的课堂任务。
              </div>
            )}
          </div>
        </A3Card>
      </div>
    </div>
  );
}

function DistributionPanel({ workbench }: { workbench: TeacherWorkbench | null }) {
  return (
    <div className="rounded-xl bg-[var(--a3-surface-muted)] p-5">
      <div className="flex items-center gap-2 text-sm font-semibold text-[var(--a3-text)]">
        <Users className="size-5 text-blue-600" />
        学生掌握分布
      </div>
      <div className="mt-5 space-y-3">
        {(workbench?.distribution ?? []).map((item) => (
          <div key={item.label}>
            <div className="mb-1 flex justify-between text-sm text-[var(--a3-text)]">
              <span>{item.label}</span>
              <span className="font-semibold">{item.count} 人</span>
            </div>
            <div className="h-2 rounded-full bg-[var(--a3-surface-solid)]">
              <div className={cn('h-full rounded-full', toneBar[item.tone])} style={{ width: `${item.percent}%` }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function KnowledgeBasePanel({ workbench }: { workbench: TeacherWorkbench | null }) {
  const stats = [
    ['总资源', workbench?.knowledgeBase.totalFiles ?? 0],
    ['已索引', workbench?.knowledgeBase.indexedFiles ?? 0],
    ['失败', workbench?.knowledgeBase.failedFiles ?? 0],
    ['处理中', workbench?.knowledgeBase.runningJobs ?? 0],
  ] as const;
  return (
    <div className="rounded-xl bg-[var(--a3-surface-muted)] p-5">
      <div className="flex items-center gap-2 text-sm font-semibold text-[var(--a3-text)]">
        <Database className="size-5 text-blue-600" />
        知识库状态
      </div>
      <div className="mt-5 grid grid-cols-2 gap-3">
        {stats.map(([label, value]) => (
          <div key={label} className="rounded-lg bg-[var(--a3-surface-solid)] p-4">
            <div className="text-sm font-medium text-[var(--a3-text-muted)]">{label}</div>
            <div className="mt-2 text-lg font-semibold text-blue-700">{value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ResourcePackStudentFilter({
  filter,
  counts,
  emptyText,
  students,
  onChange,
}: {
  filter: TeacherResourcePackFilter;
  counts: { all: number; unconverted: number; converted: number };
  emptyText: string;
  students: TeacherWorkbenchStudent[];
  onChange: (filter: TeacherResourcePackFilter) => void;
}) {
  const filters: Array<{ key: TeacherResourcePackFilter; label: string; count: number }> = [
    { key: 'all', label: '全部学生', count: counts.all },
    { key: 'unconverted', label: '未完成资源包', count: counts.unconverted },
    { key: 'converted', label: '已转化', count: counts.converted },
  ];
  return (
    <div className="mt-4 rounded-2xl border border-[var(--a3-border)] bg-[var(--a3-surface-muted)] p-4" data-testid="a3-teacher-resource-pack-filter">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-[var(--a3-text)]">资源包转化筛选</div>
          <p className="mt-1 text-xs leading-5 text-[var(--a3-text-muted)]">按是否完成推荐资源包过滤学生，方便教师定位未转化对象并推送提醒。</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {filters.map((item) => (
            <button
              key={item.key}
              type="button"
              data-testid={`a3-resource-pack-filter-${item.key}`}
              onClick={() => onChange(item.key)}
              className={cn(
                'rounded-full border px-3 py-1 text-xs font-semibold transition',
                filter === item.key ? 'border-blue-600 bg-blue-600 text-white' : 'border-slate-200 bg-white text-slate-600 hover:border-blue-300 hover:text-blue-700',
              )}
            >
              {item.label} {item.count}
            </button>
          ))}
        </div>
      </div>
      <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {students.slice(0, 6).map((student) => (
          <Link
            key={student.id}
            href={student.resourcePack?.nextAction.href ?? '/a3/recommendations'}
            className="rounded-xl border border-[var(--a3-border)] bg-white p-3 transition hover:border-blue-300 hover:bg-blue-50"
            data-testid="a3-resource-pack-filter-student"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-semibold text-[var(--a3-text)]">{student.name}</span>
              <A3Pill tone={(student.resourcePack?.totalRuns ?? 0) > 0 ? 'violet' : 'orange'}>
                {(student.resourcePack?.totalRuns ?? 0) > 0 ? `${student.resourcePack?.totalRuns} 次` : '未练习'}
              </A3Pill>
            </div>
            <p className="mt-2 text-xs leading-5 text-[var(--a3-text-muted)]">{student.resourcePack?.latestGoal || student.currentPoint}</p>
          </Link>
        ))}
        {students.length === 0 && <div className="rounded-xl bg-white p-4 text-sm text-[var(--a3-text-muted)]">{emptyText}</div>}
      </div>
    </div>
  );
}

function StudentTable({ students }: { students: TeacherWorkbenchStudent[] }) {
  return (
    <div className="mt-5 max-w-full overflow-x-auto rounded-xl border border-[var(--a3-border)]">
      <table className="w-full min-w-[900px] text-left text-sm">
        <thead className="bg-[var(--a3-surface-muted)] text-[var(--a3-text-muted)]">
          <tr>
            <th className="px-4 py-3 font-medium">学生</th>
            <th className="px-4 py-3 font-medium">方向</th>
            <th className="px-4 py-3 font-medium">当前知识点</th>
            <th className="px-4 py-3 font-medium">进度</th>
            <th className="px-4 py-3 font-medium">资源包</th>
            <th className="px-4 py-3 font-medium">风险</th>
            <th className="px-4 py-3 font-medium">建议动作</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--a3-border)]">
          {students.map((student) => (
            <tr key={student.id}>
              <td className="px-4 py-3 font-semibold text-[var(--a3-text)]">{student.name}</td>
              <td className="px-4 py-3 text-[var(--a3-text-muted)]">{student.majorDirection || student.grade || '未完善画像'}</td>
              <td className="px-4 py-3 text-[var(--a3-text)]">{student.currentPoint}</td>
              <td className="px-4 py-3">
                <div className="flex items-center gap-2">
                  <div className="h-2 w-24 rounded-full bg-slate-100">
                    <div className="h-full rounded-full bg-blue-600" style={{ width: `${student.progress}%` }} />
                  </div>
                  <span className="text-xs text-[var(--a3-text-muted)]">{student.progress}%</span>
                </div>
              </td>
              <td className="px-4 py-3">
                <div className="flex flex-col gap-1">
                  <A3Pill tone={(student.resourcePack?.totalRuns ?? 0) > 0 ? 'violet' : 'orange'}>
                    {(student.resourcePack?.totalRuns ?? 0) > 0 ? `${student.resourcePack?.totalRuns} 次` : '未练习'}
                  </A3Pill>
                  <span className="max-w-36 truncate text-xs text-[var(--a3-text-muted)]">
                    {student.resourcePack?.latestGoal || '等待推荐转化'}
                  </span>
                  <span className="text-xs text-[var(--a3-text-muted)]">
                    课堂 {student.resourcePack?.artifactCounts?.classroomSucceeded ?? 0} / 视频降级 {student.resourcePack?.artifactCounts?.videoDegraded ?? 0}
                  </span>
                </div>
              </td>
              <td className="px-4 py-3">
                <A3Pill tone={riskTone[student.riskLevel]}>{riskLabel[student.riskLevel]}</A3Pill>
              </td>
              <td className="px-4 py-3 text-[var(--a3-text-muted)]">{student.interventionAction?.label ?? student.prescription?.primaryAction.label ?? '保持观察'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ResourcePackSummaryCard({
  summary,
  executing,
  onExecute,
}: {
  summary: NonNullable<TeacherWorkbench['resourcePackSummary']>;
  executing: boolean;
  onExecute: () => void;
}) {
  return (
    <A3Card
      title="推荐资源包转化"
      subtitle="查看推荐资源是否真正进入学生练习，便于教师对未转化学生做提醒。"
      action={<A3Pill tone={summary.completionRate >= 60 ? 'green' : 'orange'}>{summary.completionRate}% 完成率</A3Pill>}
    >
      <div className="grid gap-4 xl:grid-cols-[280px_1fr_320px]">
        <div className="rounded-2xl bg-violet-50 p-5">
          <div className="text-sm font-semibold text-violet-900">班级资源包闭环</div>
          <div className="mt-3 flex items-end gap-2">
            <span className="text-4xl font-semibold text-violet-950">{summary.completedStudents}</span>
            <span className="pb-1 text-sm text-violet-700">/ {summary.totalStudents} 人</span>
          </div>
          <p className="mt-3 text-sm leading-6 text-violet-800">
            已完成 {summary.totalRuns} 次资源包学习，累计引用 {summary.verifiedSourceCount} 个验证来源。
          </p>
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          <EvidenceMetric label="资源包次数" value={`${summary.totalRuns}`} detail="推荐进入今日任务后的完成记录" />
          <EvidenceMetric label="专项练习" value={`${summary.practiceStartedCount}`} detail="完成后指向测评的练习入口" />
          <EvidenceMetric label="证据来源" value={`${summary.verifiedSourceCount}`} detail="已验证引用来源累计数" />
        </div>
        <div className="rounded-2xl border border-orange-100 bg-orange-50 p-5">
          <div className="flex items-center gap-2 text-sm font-semibold text-orange-900">
            <AlertTriangle className="size-4" />
            未转化学生
          </div>
          <div className="mt-3 space-y-2">
            {summary.needsPracticeStudents.length ? (
              summary.needsPracticeStudents.slice(0, 3).map((student) => (
                <div key={student.id} className="rounded-xl bg-white/80 p-3">
                  <div className="text-sm font-semibold text-orange-950">{student.name}</div>
                  <div className="mt-1 text-xs text-orange-700">{student.currentPoint}</div>
                </div>
              ))
            ) : (
              <div className="rounded-xl bg-white/80 p-3 text-sm text-orange-800">当前展示学生均已完成至少一次资源包闭环。</div>
            )}
          </div>
          <Button
            size="sm"
            className="mt-4 w-full bg-orange-600 hover:bg-orange-700"
            disabled={executing || summary.needsPracticeStudents.length === 0}
            onClick={onExecute}
          >
            {executing ? <Loader2 className="size-4 animate-spin" /> : <AlertTriangle className="size-4" />}
            提醒未练习学生
          </Button>
        </div>
      </div>
    </A3Card>
  );
}

function OpenMAICArtifactEffectCardV2({
  summary,
}: {
  summary: NonNullable<TeacherWorkbench['resourcePackSummary']>;
}) {
  const latestArtifacts = sortOpenMAICArtifactHistory(summary.latestArtifacts ?? []);
  const artifactSummary = teacherArtifactCountsToSummary(summary.artifactCounts, latestArtifacts);
  const providers = summarizeArtifactProvidersV2(latestArtifacts);
  const hasDegraded = artifactSummary.degraded > 0;

  return (
    <A3Card
      title="OpenMAIC 课堂 / PPTX / 视频资源效果"
      subtitle="来自 OpenMAICArtifact 审计表和 A3 资源包 multimodalArtifacts，用于判断课堂、PPTX 导出、短视频是否真实生成、降级并回流。"
      action={<A3Pill tone={hasDegraded ? 'orange' : 'green'}>{artifactSummary.total} artifacts</A3Pill>}
    >
      <div className="grid gap-4 xl:grid-cols-[420px_1fr]" data-testid="a3-teacher-openmaic-artifacts">
        <div className="grid gap-3 sm:grid-cols-2">
          <EvidenceMetric label="课堂成功" value={`${artifactSummary.classroomSucceeded}/${artifactSummary.classroom}`} detail="课堂 artifact 成功后可进入 OpenMAIC，并在课堂内发起 PPTX 导出" />
          <EvidenceMetric label="PPTX 导出" value={`${artifactSummary.pptxExportSucceeded}/${artifactSummary.pptxExport}`} detail="OpenMAIC 前端完成 PPTX 导出后写回 A3 审计链" />
          <EvidenceMetric label="视频成功" value={`${artifactSummary.videoSucceeded}/${artifactSummary.video}`} detail="短视频脚本提交 /api/generate/video 后的成功次数" />
          <EvidenceMetric label="降级记录" value={`${artifactSummary.degraded}`} detail="provider 未配置、生成失败或未验证的 artifact 会进入降级统计" />
          <EvidenceMetric label="最近回写" value={artifactSummary.latestAt ? formatArtifactTimestamp(latestArtifacts[0]) : '暂无'} detail="按 completedAt/createdAt 倒序展示，不只看最新摘要" />
          <div className="rounded-xl border border-[var(--a3-border)] bg-[var(--a3-surface-muted)] p-4 sm:col-span-2">
            <div className="text-xs text-[var(--a3-text-muted)]">provider 来源</div>
            <div className="mt-3 flex flex-wrap gap-2" data-testid="a3-teacher-openmaic-provider-summary">
              {providers.map((item) => (
                <A3Pill key={item.provider} tone={item.degraded > 0 ? 'orange' : 'green'}>
                  {item.provider} · {item.total} 次{item.degraded ? ` / 降级 ${item.degraded}` : ''}
                </A3Pill>
              ))}
              {!providers.length && <span className="text-xs text-[var(--a3-text-muted)]">暂无 provider 记录</span>}
            </div>
          </div>
        </div>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {latestArtifacts.slice(0, 9).map((artifact, index) => (
            <Link
              key={`${artifact.type}-${artifact.jobId || artifact.resourcePackId || index}`}
              href={artifact.resourcePackId ? `/a3/resources/${artifact.resourcePackId}` : (artifact.classroomUrl || artifact.videoUrl || '/a3/recommendations')}
              className="rounded-xl border border-[var(--a3-border)] bg-[var(--a3-surface-muted)] p-4 transition hover:border-blue-300 hover:bg-blue-50"
              data-testid="a3-teacher-openmaic-artifact"
            >
              <div className="flex items-center justify-between gap-2">
                <A3Pill tone={artifact.status === 'succeeded' ? 'green' : 'orange'}>{artifact.status}</A3Pill>
                <span className="text-xs text-[var(--a3-text-muted)]">{artifactLabelV2(artifact.type)}</span>
              </div>
              <div className="mt-3 text-sm font-semibold text-[var(--a3-text)]">
                {artifact.learningGoal || artifact.fileName || artifact.resourceType || 'OpenMAIC artifact'}
              </div>
              <p className="mt-2 line-clamp-2 text-xs leading-5 text-[var(--a3-text-muted)]">
                {artifact.degradedReason || artifact.classroomUrl || artifact.videoUrl || artifact.provider || '已回写到 A3 资源包'}
              </p>
              <div className="mt-2 grid gap-1 text-xs text-[var(--a3-text-muted)]">
                {artifact.resourcePackId ? <span>资源包：{artifact.resourcePackId}</span> : null}
                {artifact.type === 'openmaic_classroom' ? (
                  <span>场景 {artifact.scenesCount ?? 0} · PPTX {artifact.pptxExportable ? '可导出' : '待生成'}</span>
                ) : null}
                {artifact.type === 'openmaic_pptx_export' ? (
                  <span>文件 {artifact.fileName || '未记录'} · {artifact.slidesCount ?? 0} 页</span>
                ) : null}
                {artifact.type === 'openmaic_video' ? (
                  <span>视频 {artifact.duration || 0}s · {artifact.width || 0}x{artifact.height || 0}</span>
                ) : null}
                {artifact.provider ? <span>provider：{artifact.provider}</span> : null}
              </div>
              {artifact.jobId && <div className="mt-2 truncate font-mono text-xs text-slate-500">job: {artifact.jobId}</div>}
              <div className="mt-2 text-xs text-[var(--a3-text-muted)]">{formatArtifactTimestamp(artifact)}</div>
            </Link>
          ))}
          {!latestArtifacts.length && (
            <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-4 text-sm text-[var(--a3-text-muted)]">
              暂无 OpenMAIC 课堂、PPTX 或视频产物。请先在推荐页生成资源包课堂/视频任务。
            </div>
          )}
        </div>
      </div>
    </A3Card>
  );
}

function artifactLabelV2(type: string): string {
  if (type === 'openmaic_video') return '视频';
  if (type === 'openmaic_pptx_export') return 'PPTX 导出';
  return '课堂';
}

function summarizeArtifactProvidersV2(artifacts: NonNullable<TeacherWorkbench['resourcePackSummary']>['latestArtifacts'] = []) {
  const map = new Map<string, { provider: string; total: number; degraded: number }>();
  for (const artifact of artifacts) {
    const fallbackProvider = artifact.type === 'openmaic_classroom'
      ? 'openmaic-generate-classroom'
      : artifact.type === 'openmaic_pptx_export'
        ? 'openmaic-pptx-export'
        : 'provider 未记录';
    const provider = artifact.provider || fallbackProvider;
    const current = map.get(provider) ?? { provider, total: 0, degraded: 0 };
    current.total += 1;
    if (artifact.status !== 'succeeded' || artifact.degradedReason) current.degraded += 1;
    map.set(provider, current);
  }
  return [...map.values()].sort((left, right) => right.total - left.total || left.provider.localeCompare(right.provider));
}

function RiskStudentsCard({ students }: { students: TeacherWorkbenchStudent[] }) {
  const riskStudents = students.filter((item) => item.riskLevel !== 'low').slice(0, 4);
  return (
    <A3Card title="待干预提醒">
      <div className="space-y-3">
        {riskStudents.map((item) => (
          <div key={item.id} className="rounded-xl bg-orange-50 p-4 text-sm text-orange-900">
            <div className="flex gap-3">
              <AlertTriangle className="mt-0.5 size-5 shrink-0" />
              <span className="font-semibold">{item.name}</span>
              <A3Pill tone={item.riskLevel === 'high' ? 'red' : 'orange'}>{item.riskLevel === 'high' ? '高风险' : '中风险'}</A3Pill>
            </div>
            <div className="mt-2 ml-8 text-xs leading-5 text-orange-800">
              {item.currentPoint} · 进度 {item.progress}% · 错题信号 {item.wrongSignal}
            </div>
            {item.riskReason && (
              <div className="mt-1 ml-8 text-xs leading-5 text-orange-700">{item.riskReason}</div>
            )}
          </div>
        ))}
        {!riskStudents.length && (
          <div className="flex gap-3 rounded-xl bg-emerald-50 p-4 text-sm text-emerald-800">
            <CheckCircle2 className="mt-0.5 size-5 shrink-0" />
            当前没有高风险学生。
          </div>
        )}
      </div>
    </A3Card>
  );
}

function WeakPointsCard({ weakPoints, showEmpty }: { weakPoints: NonNullable<TeacherWorkbench['weakPoints']>; showEmpty: boolean }) {
  return (
    <A3Card
      title="班级薄弱知识点"
      subtitle="统计来自学生未掌握错题，按知识点汇总人数。红色表示 3 人及以上，橙色表示 1-2 人。"
    >
      <div className="space-y-4">
        {weakPoints.map((item) => (
          <div key={item.label} className="space-y-2" data-testid="a3-teacher-weak-point-row">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-[var(--a3-text)]">{item.label}</div>
                <div className="mt-1 text-xs text-[var(--a3-text-muted)]">{item.meta}</div>
              </div>
              <A3Pill tone={item.tone}>{item.value} 人</A3Pill>
            </div>
            <div className="h-2 rounded-full bg-slate-100">
              <div
                className={cn(
                  'h-full rounded-full',
                  item.tone === 'red' ? 'bg-rose-500' : item.tone === 'orange' ? 'bg-orange-500' : 'bg-blue-500',
                )}
                style={{ width: `${item.progress}%` }}
              />
            </div>
          </div>
        ))}
        {showEmpty && !weakPoints.length && (
          <div data-testid="a3-teacher-weak-points-empty" className="rounded-xl bg-[var(--a3-surface-muted)] p-4 text-sm text-[var(--a3-text-muted)]">
            当前没有需要班级集中巩固的知识点。
          </div>
        )}
      </div>
      {weakPoints.some((item) => item.tone === 'red') && (
        <div className="mt-4 rounded-xl border border-rose-100 bg-rose-50 px-4 py-3 text-xs leading-5 text-rose-800">
          存在多名学生共同薄弱的知识点。建议优先安排专项讲解或通过任务队列生成定向练习，再下发给全班。
        </div>
      )}
    </A3Card>
  );
}

function PrescriptionCard({ student, executing, onExecute }: { student: TeacherWorkbenchStudent; executing: boolean; onExecute: () => void }) {
  const prescription = student.prescription;
  const primaryAction = student.interventionAction ?? prescription?.primaryAction;

  return (
    <div className="rounded-xl border border-[var(--a3-border)] bg-[var(--a3-surface-solid)] p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-[var(--a3-text)]">{student.name}</span>
            <A3Pill tone={riskTone[student.riskLevel]}>{riskLabel[student.riskLevel]}</A3Pill>
          </div>
          <p className="mt-1 text-xs text-[var(--a3-text-muted)]">
            {student.currentPoint} · 进度 {student.progress}% · 错题信号 {student.wrongSignal}
          </p>
        </div>
        <Sparkles className="size-4 shrink-0 text-blue-600" />
      </div>

      <div className="mt-3 rounded-lg bg-[var(--a3-surface-muted)] p-3">
        <div className="text-sm font-semibold text-[var(--a3-text)]">{prescription?.title ?? '保持学习节奏'}</div>
        <p className="mt-1 text-xs leading-5 text-[var(--a3-text-muted)]">
          {prescription?.reason ?? '当前没有明显风险信号，建议维持今日任务和阶段测评节奏。'}
        </p>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {primaryAction ? (
          <Button size="sm" data-testid="a3-student-intervention" className="bg-blue-600 hover:bg-blue-700" disabled={executing} onClick={onExecute}>
            {executing ? <Loader2 className="size-4 animate-spin" /> : null}
            {primaryAction.label}
          </Button>
        ) : null}
        {primaryAction ? <A3Pill tone={actionTone[primaryAction.type]}>{primaryAction.type}</A3Pill> : null}
      </div>

      {prescription?.actions?.length ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {prescription.actions.slice(0, 3).map((action) => (
            <Button key={`${student.id}-${action.type}-${action.href}`} asChild size="sm" variant="outline">
              <Link href={action.href}>{action.label}</Link>
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function EvidenceMetric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="rounded-xl border border-[var(--a3-border)] bg-[var(--a3-surface-muted)] p-4">
      <div className="text-xs text-[var(--a3-text-muted)]">{label}</div>
      <div className="mt-2 text-lg font-semibold text-[var(--a3-text)]">{value}</div>
      <div className="mt-1 text-xs text-[var(--a3-text-muted)]">{detail}</div>
    </div>
  );
}

function TaskRow({ task, executing, onExecute }: { task: TeacherTask; executing: boolean; onExecute: () => void }) {
  return (
    <div data-testid="a3-teacher-task-row" className="flex items-center justify-between rounded-xl border border-[var(--a3-border)] p-4">
      <div className="flex min-w-0 items-center gap-3">
        <BookOpen className="size-4 shrink-0 text-blue-600" />
        <span className="truncate text-sm font-medium text-[var(--a3-text)]">{task.title}</span>
        {task.status === 'warning' && <A3Pill tone="orange">需处理</A3Pill>}
        {task.status === 'running' && <A3Pill tone="blue">处理中</A3Pill>}
      </div>
      <Button size="sm" variant="outline" disabled={executing} onClick={onExecute}>
        {executing ? <Loader2 className="size-4 animate-spin" /> : null}
        执行
      </Button>
    </div>
  );
}
