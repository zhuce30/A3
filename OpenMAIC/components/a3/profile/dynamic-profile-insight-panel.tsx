'use client';

import Link from 'next/link';
import { ArrowRight, Brain, History, Sparkles, Target } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { A3Pill } from '@/components/a3/ui/a3-card';
import { ProfileDimensionRadar } from '@/components/a3/profile/profile-dimension-radar';
import type { A3ProfileSnapshot } from '@/lib/a3/auth-types';

export type DynamicProfileInsight = {
  schemaVersion?: string;
  cognitiveStyle?: string;
  learningHistory?: string;
  mistakePatterns?: string[];
  motivationRisk?: string;
  resourcePreferenceEvidence?: Array<{ resource?: string; source?: string; weight?: number }>;
  learningEventsSummary?: {
    total?: number;
    byType?: Record<string, number>;
    latestAt?: string;
  };
  dimensionCoverage?: {
    ready?: number;
    total?: number;
    missing?: Array<{ field?: string; label?: string }>;
    labels?: string[];
  };
  recentEvents?: Array<{
    eventType?: string;
    summary?: string;
    source?: string;
    createdAt?: string;
  }>;
  llm?: { provider?: string; model?: string; fallback?: boolean };
  dimensions?: A3ProfileSnapshot['dimensions'];
  signalSummary?: A3ProfileSnapshot['signalSummary'];
  updatedAt?: string;
};

export function DynamicProfileInsightPanel({
  dynamicProfile,
  profileSnapshot = null,
  className = '',
  compact = false,
  title = '动态学情画像',
  subtitle = '来自画像访谈、诊断、测评错题和课堂问答。',
}: {
  dynamicProfile: DynamicProfileInsight | null;
  profileSnapshot?: A3ProfileSnapshot | null;
  className?: string;
  compact?: boolean;
  title?: string;
  subtitle?: string;
}) {
  const events = dynamicProfile?.learningEventsSummary?.byType ?? {};
  const eventRows = Object.entries(events).filter(([, count]) => Number(count) > 0).slice(0, compact ? 3 : 4);
  const mistakes = dynamicProfile?.mistakePatterns ?? [];
  const resources = dynamicProfile?.resourcePreferenceEvidence ?? [];
  const ready = dynamicProfile?.dimensionCoverage?.ready ?? countReadyDimensions(dynamicProfile);
  const total = dynamicProfile?.dimensionCoverage?.total ?? 6;
  const eventTotal = dynamicProfile?.learningEventsSummary?.total ?? 0;
  const signalSummary = profileSnapshot?.signalSummary ?? dynamicProfile?.signalSummary;
  const signalRows = Object.entries(signalSummary?.bySource ?? {}).filter(([, count]) => Number(count) > 0).slice(0, compact ? 4 : 6);
  const snapshotDimensions = profileSnapshot?.dimensions ?? dynamicProfile?.dimensions;
  const confidenceAverage = averageDimensionConfidence(snapshotDimensions);

  return (
    <section data-testid="a3-dynamic-profile-insight" className={`overflow-hidden rounded-[26px] border border-blue-100 bg-white shadow-[0_18px_50px_rgba(15,23,42,0.06)] ${className}`}>
      <div className="border-b border-blue-100 bg-gradient-to-r from-blue-50 via-white to-emerald-50 px-5 py-4 md:px-6">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-blue-600 text-white shadow-[0_12px_30px_rgba(37,99,235,0.20)]">
              <Brain className="size-5" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-slate-950">{title}</h2>
              <p className="mt-1 text-sm leading-5 text-slate-500">{subtitle}</p>
            </div>
          </div>
          <A3Pill tone={ready >= total ? 'green' : ready >= 3 ? 'blue' : 'orange'}>
            {ready}/{total} 维度
          </A3Pill>
        </div>
      </div>

      {dynamicProfile ? (
        <div className="p-5 md:p-6">
          {compact ? (
            <>
              <CompactProfileSummary
                ready={ready}
                total={total}
                eventTotal={eventTotal}
                mistakes={mistakes}
              />
              <CompactProfileEvidence
                signalTotal={signalSummary?.total}
                confidenceAverage={confidenceAverage}
                signalRows={signalRows}
              />
              {snapshotDimensions && (
                <ProfileDimensionRadar dimensions={snapshotDimensions} className="mt-3" compact />
              )}
              <CompactProfileDetails
                dynamicProfile={dynamicProfile}
                eventRows={eventRows}
                mistakes={mistakes}
                resources={resources}
              />
              <CompactProfileFooter dynamicProfile={dynamicProfile} />
            </>
          ) : (
            <>
              <div className="grid gap-3 md:grid-cols-3">
                <ProfileStatTile label="画像维度" value={`${ready}/${total}`} detail={ready >= total ? '可用于推荐' : '继续沉淀'} tone="blue" />
                <ProfileStatTile label="事件记忆" value={`${eventTotal}`} detail="访谈/诊断/测评/课堂" tone="green" />
                <ProfileStatTile label="错因模式" value={`${mistakes.length}`} detail={mistakes[0] || '等待复盘'} tone="orange" />
              </div>

              {(signalSummary || confidenceAverage !== null) && (
                <div className="mt-4 rounded-2xl border border-indigo-100 bg-indigo-50/70 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold text-indigo-950">画像信号证据</div>
                      <div className="mt-1 text-xs text-indigo-800/75">
                        信号总数 {formatNullableNumber(signalSummary?.total)} · 平均置信度 {formatConfidence(confidenceAverage)}
                      </div>
                    </div>
                    <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-indigo-700">
                      证据汇总
                    </span>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {signalRows.length ? signalRows.map(([source, count]) => (
                      <span key={source} className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-indigo-700">
                        {profileSignalSourceLabel(source)} {count}
                      </span>
                    )) : (
                      <span className="text-xs font-medium text-indigo-700">暂无来源计数</span>
                    )}
                  </div>
                </div>
              )}

              {snapshotDimensions && (
                <ProfileDimensionRadar dimensions={snapshotDimensions} className="mt-4" />
              )}

              <div className="mt-4 grid gap-4 xl:grid-cols-[1fr_1fr_1fr]">
                <div className="grid gap-3">
                  <ProfileSignalCard icon={Brain} label="认知风格" value={dynamicProfile.cognitiveStyle || '等待画像访谈补充'} />
                  <ProfileSignalCard icon={History} label="学习历史" value={dynamicProfile.learningHistory || '等待诊断和学习记录补充'} />
                  <ProfileSignalCard icon={Target} label="动机风险" value={dynamicProfile.motivationRisk || '暂无明显风险'} />
                </div>

                <div className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4">
                  <div className="text-sm font-semibold text-slate-950">事件来源</div>
                  <div className="mt-3 grid gap-2 text-sm">
                    {eventRows.length ? eventRows.map(([type, count]) => (
                      <div key={type} className="flex items-center justify-between rounded-xl bg-white px-3 py-2">
                        <span className="text-slate-600">{dynamicLearningEventLabel(type)}</span>
                        <span className="font-semibold text-slate-950">{count}</span>
                      </div>
                    )) : <div className="rounded-xl bg-white px-3 py-2 text-slate-500">暂无事件来源</div>}
                  </div>
                  {(dynamicProfile.recentEvents ?? []).length > 0 && (
                    <div className="mt-3 space-y-2">
                      {(dynamicProfile.recentEvents ?? []).slice(0, 2).map((event, index) => (
                        <div key={`${event.eventType}-${event.createdAt}-${index}`} className="rounded-xl bg-white px-3 py-2 text-xs leading-5 text-slate-600">
                          <span className="font-semibold text-slate-900">{dynamicLearningEventLabel(event.eventType || '')}：</span>
                          {event.summary || '已记录学习事件'}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div>
                  <div className="rounded-2xl border border-orange-100 bg-orange-50 p-4">
                    <div className="text-sm font-semibold text-orange-950">错因模式</div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {mistakes.length ? mistakes.slice(0, 6).map((item) => (
                        <span key={item} className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-orange-700">{item}</span>
                      )) : <span className="text-sm text-orange-700">等待错题复盘沉淀</span>}
                    </div>
                  </div>
                  <div className="mt-3 rounded-2xl border border-blue-100 bg-blue-50 p-4">
                    <div className="text-sm font-semibold text-blue-950">资源偏好证据</div>
                    <p className="mt-2 text-sm leading-6 text-blue-800">
                      {resources.length ? resources.map((item) => item.resource).filter(Boolean).slice(0, 6).join('、') : '等待画像访谈或资源反馈沉淀'}
                    </p>
                  </div>
                </div>
              </div>

              <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-500">
                <span>
                  {dynamicProfile.updatedAt ? `画像更新于 ${new Date(dynamicProfile.updatedAt).toLocaleString('zh-CN')}` : '等待画像更新'}
                </span>
                <span>
                  {dynamicProfile.llm?.provider ? `抽取来源：${dynamicProfile.llm.provider}${dynamicProfile.llm.model ? ` / ${dynamicProfile.llm.model}` : ''}` : '抽取来源：规则与学习事件'}
                </span>
              </div>
            </>
          )}
        </div>
      ) : (
        <div className="p-5 md:p-6">
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-5">
            <div className="flex items-start gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-white text-blue-600">
                <Sparkles className="size-5" />
              </div>
              <div>
                <div className="font-semibold text-slate-950">等待画像事件积累</div>
                <p className="mt-2 text-sm leading-6 text-slate-600">
                  完成画像访谈、入学诊断、测评错题或课堂问答后，这里会展示认知风格、错因模式和事件来源。
                </p>
                <Button asChild size="sm" className="mt-4 bg-blue-600 hover:bg-blue-700">
                  <Link href="/a3/profile-setup">
                    去完善画像
                    <ArrowRight className="size-4" />
                  </Link>
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function CompactProfileSummary({
  ready,
  total,
  eventTotal,
  mistakes,
}: {
  ready: number;
  total: number;
  eventTotal: number;
  mistakes: string[];
}) {
  const percent = total > 0 ? Math.min(100, Math.round((ready / total) * 100)) : 0;
  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs font-medium text-slate-500">画像完整度</div>
          <div className="mt-1 text-2xl font-semibold tracking-tight text-slate-950">{ready}/{total}</div>
        </div>
        <span className="shrink-0 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700">
          {percent}%
        </span>
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-slate-200">
        <div className="h-full rounded-full bg-blue-600" style={{ width: `${percent}%` }} />
      </div>
      <div className="mt-4 grid grid-cols-2 gap-2">
        <CompactMetric label="事件记忆" value={eventTotal} detail="学习事件" />
        <CompactMetric label="错因模式" value={mistakes.length} detail={mistakes.length ? '已识别' : '待沉淀'} />
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {mistakes.length ? mistakes.slice(0, 3).map((item) => (
          <span key={item} className="max-w-full rounded-full bg-orange-50 px-2.5 py-1 text-xs font-semibold leading-5 text-orange-700">
            {item}
          </span>
        )) : (
          <span className="rounded-full bg-white px-2.5 py-1 text-xs font-medium text-slate-500">等待错题复盘</span>
        )}
      </div>
    </div>
  );
}

function CompactProfileEvidence({
  signalTotal,
  confidenceAverage,
  signalRows,
}: {
  signalTotal?: number;
  confidenceAverage: number | null;
  signalRows: Array<[string, number]>;
}) {
  return (
    <div className="mt-3 rounded-2xl border border-indigo-100 bg-indigo-50/70 p-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-xs font-semibold text-indigo-950">画像信号证据</div>
          <div className="mt-1 text-xs text-indigo-800/75">
            {formatNullableNumber(signalTotal)} 条 · 置信度 {formatConfidence(confidenceAverage)}
          </div>
        </div>
        <span className="shrink-0 rounded-full bg-white px-2.5 py-1 text-xs font-semibold text-indigo-700">
          证据
        </span>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {signalRows.length ? signalRows.slice(0, 3).map(([source, count]) => (
          <span key={source} className="rounded-full bg-white px-2.5 py-1 text-xs font-semibold leading-5 text-indigo-700">
            {profileSignalSourceLabel(source)} {count}
          </span>
        )) : (
          <span className="text-xs font-medium text-indigo-700">暂无来源计数</span>
        )}
      </div>
    </div>
  );
}

function CompactProfileDetails({
  dynamicProfile,
  eventRows,
  mistakes,
  resources,
}: {
  dynamicProfile: DynamicProfileInsight;
  eventRows: Array<[string, number]>;
  mistakes: string[];
  resources: Array<{ resource?: string; source?: string; weight?: number }>;
}) {
  return (
    <details className="mt-3 rounded-2xl border border-slate-200 bg-white p-3">
      <summary className="cursor-pointer list-none text-sm font-semibold text-slate-950">
        查看画像细节
      </summary>
      <div className="mt-3 space-y-3">
        <CompactDetailRow label="认知风格" value={dynamicProfile.cognitiveStyle || '等待画像访谈补充'} />
        <CompactDetailRow label="学习历史" value={dynamicProfile.learningHistory || '等待诊断和学习记录补充'} />
        <CompactDetailRow label="动机风险" value={dynamicProfile.motivationRisk || '暂无明显风险'} />
        <div className="rounded-xl bg-slate-50 px-3 py-2">
          <div className="text-xs font-medium text-slate-500">事件来源</div>
          <div className="mt-2 grid gap-1.5 text-xs">
            {eventRows.length ? eventRows.map(([type, count]) => (
              <div key={type} className="flex items-center justify-between gap-3">
                <span className="text-slate-600">{dynamicLearningEventLabel(type)}</span>
                <span className="font-semibold text-slate-950">{count}</span>
              </div>
            )) : <span className="text-slate-500">暂无事件来源</span>}
          </div>
        </div>
        <div className="rounded-xl bg-orange-50 px-3 py-2">
          <div className="text-xs font-medium text-orange-800">错因模式</div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {mistakes.length ? mistakes.slice(0, 4).map((item) => (
              <span key={item} className="rounded-full bg-white px-2 py-1 text-xs font-semibold leading-5 text-orange-700">{item}</span>
            )) : <span className="text-xs text-orange-700">等待错题复盘沉淀</span>}
          </div>
        </div>
        <CompactDetailRow
          label="资源偏好"
          value={resources.length ? resources.map((item) => item.resource).filter(Boolean).slice(0, 4).join('、') : '等待画像访谈或资源反馈沉淀'}
        />
      </div>
    </details>
  );
}

function CompactDetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-slate-50 px-3 py-2">
      <div className="text-xs font-medium text-slate-500">{label}</div>
      <div className="mt-1 text-sm leading-5 text-slate-700">{value}</div>
    </div>
  );
}

function CompactProfileFooter({ dynamicProfile }: { dynamicProfile: DynamicProfileInsight }) {
  return (
    <div className="mt-3 space-y-1 text-xs leading-5 text-slate-500">
      <div>{dynamicProfile.updatedAt ? `更新于 ${new Date(dynamicProfile.updatedAt).toLocaleString('zh-CN')}` : '等待画像更新'}</div>
      <div>{dynamicProfile.llm?.provider ? `抽取：${dynamicProfile.llm.provider}${dynamicProfile.llm.model ? ` / ${dynamicProfile.llm.model}` : ''}` : '抽取：规则与学习事件'}</div>
    </div>
  );
}

function CompactMetric({ label, value, detail }: { label: string; value: number; detail: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-3 py-2.5">
      <div className="text-xs font-medium text-slate-500">{label}</div>
      <div className="mt-1 flex items-end justify-between gap-2">
        <span className="text-xl font-semibold text-slate-950">{value}</span>
        <span className="shrink-0 text-xs text-slate-500">{detail}</span>
      </div>
    </div>
  );
}

function ProfileStatTile({ label, value, detail, tone }: { label: string; value: string; detail: string; tone: 'blue' | 'green' | 'orange' }) {
  const toneClass = tone === 'green' ? 'bg-emerald-50 text-emerald-800' : tone === 'orange' ? 'bg-orange-50 text-orange-800' : 'bg-blue-50 text-blue-800';
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4">
      <div className="text-xs font-medium text-slate-500">{label}</div>
      <div className="mt-2 flex items-end justify-between gap-3">
        <div className="text-2xl font-semibold text-slate-950">{value}</div>
        <span className={`max-w-[70%] rounded-full px-2.5 py-1 text-xs font-semibold leading-5 ${toneClass}`}>{detail}</span>
      </div>
    </div>
  );
}

function ProfileSignalCard({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4">
      <div className="flex items-center gap-2 text-sm font-semibold text-slate-950">
        <Icon className="size-4 text-blue-600" />
        {label}
      </div>
      <p className="mt-2 text-sm leading-6 text-slate-600">{value}</p>
    </div>
  );
}

function countReadyDimensions(dynamicProfile: DynamicProfileInsight | null) {
  if (!dynamicProfile) return 0;
  return [
    dynamicProfile.cognitiveStyle,
    dynamicProfile.learningHistory,
    dynamicProfile.motivationRisk,
    dynamicProfile.mistakePatterns?.length,
    dynamicProfile.resourcePreferenceEvidence?.length,
    dynamicProfile.learningEventsSummary?.total,
  ].filter(Boolean).length;
}

function averageDimensionConfidence(dimensions?: A3ProfileSnapshot['dimensions']) {
  const values = Object.values(dimensions ?? {})
    .map((item) => Number(item.confidence))
    .filter((value) => Number.isFinite(value));
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function formatConfidence(value: number | null) {
  if (value === null) return '暂无';
  return `${Math.round(value * 100)}%`;
}

function formatNullableNumber(value?: number) {
  return Number.isFinite(value) ? String(value) : '暂无';
}

function profileSignalSourceLabel(source: string) {
  if (source === 'profile_interview') return '画像访谈';
  if (source === 'assessment_wrong_answer') return '测评错题';
  if (source === 'admission_diagnostic') return '入学诊断';
  if (source === 'classroom_qa') return '课堂问答';
  if (source === 'profile_manual_edit') return '手动校准';
  if (source === 'stable_profile') return '基础画像';
  return source || '其他来源';
}

function dynamicLearningEventLabel(type: string) {
  if (type === 'profile_interview') return '画像访谈';
  if (type === 'assessment_wrong_answer') return '测评错题';
  if (type === 'admission_diagnostic') return '入学诊断';
  if (type === 'classroom_qa') return '课堂问答';
  if (type === 'profile_manual_edit') return '手动校准';
  return type || '学习事件';
}
