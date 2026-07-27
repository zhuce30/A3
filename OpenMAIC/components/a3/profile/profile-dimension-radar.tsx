'use client';

import { useMemo } from 'react';
import type { A3ProfileSnapshot, A3ProfileSnapshotDimension } from '@/lib/a3/auth-types';

// 画像 14 维的中文标签（与后端 profile_aggregator.PROFILE_SNAPSHOT_DIMENSIONS 对齐）。
const DIMENSION_ORDER = [
  'grade',
  'majorDirection',
  'foundationLevel',
  'dailyStudyTime',
  'pace',
  'learningGoals',
  'weakPoints',
  'resourcePreferences',
  'cognitiveStyle',
  'learningHistory',
  'mistakePatterns',
  'motivationRisk',
  'learningPace',
  'resourceEffectiveness',
] as const;

const DIMENSION_LABELS: Record<string, string> = {
  grade: '年级',
  majorDirection: '专业方向',
  foundationLevel: '基础水平',
  dailyStudyTime: '每日学时',
  pace: '学习节奏',
  learningGoals: '学习目标',
  weakPoints: '薄弱点',
  resourcePreferences: '资源偏好',
  cognitiveStyle: '认知风格',
  learningHistory: '学习历史',
  mistakePatterns: '错因模式',
  motivationRisk: '动机风险',
  learningPace: '学习进度',
  resourceEffectiveness: '资源效果',
};

// basis：值来自稳定档案字段还是信号推断，决定顶点配色与图例。
type DimensionBasis = 'stable_field' | 'signals' | 'stable_field+signals' | 'missing' | string;

const BASIS_META: Record<string, { label: string; color: string }> = {
  stable_field: { label: '档案字段', color: '#4f6f52' },
  'stable_field+signals': { label: '字段+信号', color: '#b7791f' },
  signals: { label: '证据推断', color: '#d97706' },
  missing: { label: '待补充', color: '#cbd5e1' },
};

function basisMeta(basis: DimensionBasis) {
  return BASIS_META[basis] ?? BASIS_META.signals;
}

type RadarPoint = {
  key: string;
  label: string;
  confidence: number;
  basis: DimensionBasis;
  missing: boolean;
  hasValue: boolean;
};

function dimensionHasValue(dimension: A3ProfileSnapshotDimension | undefined): boolean {
  if (!dimension) return false;
  if (dimension.missing) return false;
  const value = dimension.value;
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value as Record<string, unknown>).length > 0;
  return true;
}

function toRadarPoints(dimensions: A3ProfileSnapshot['dimensions'] | undefined): RadarPoint[] {
  if (!dimensions) return [];
  return DIMENSION_ORDER.map((key) => {
    const dimension = dimensions[key];
    const hasValue = dimensionHasValue(dimension);
    const confidence = hasValue ? clamp01(Number(dimension?.confidence)) : 0;
    return {
      key,
      label: DIMENSION_LABELS[key] ?? key,
      confidence,
      basis: hasValue ? String(dimension?.basis || 'signals') : 'missing',
      missing: !hasValue,
      hasValue,
    };
  });
}

function clamp01(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

const SIZE = 300;
const CENTER = SIZE / 2;
const MAX_RADIUS = 104;
const LABEL_RADIUS = MAX_RADIUS + 24;
// 左右两侧的维度标签会向外延伸（textAnchor start/end），
// 若 viewBox 只有 0..SIZE，「动机风险」「错因模式」这类标签会被裁掉，故横向留白。
const LABEL_PAD = 48;
const VIEW_BOX = `${-LABEL_PAD} 0 ${SIZE + LABEL_PAD * 2} ${SIZE}`;
const RINGS = [0.25, 0.5, 0.75, 1];

function polar(index: number, total: number, radius: number) {
  const angle = -Math.PI / 2 + (index * 2 * Math.PI) / total;
  return {
    x: CENTER + radius * Math.cos(angle),
    y: CENTER + radius * Math.sin(angle),
    cos: Math.cos(angle),
    sin: Math.sin(angle),
  };
}

export function ProfileDimensionRadar({
  dimensions,
  className = '',
  compact = false,
}: {
  dimensions: A3ProfileSnapshot['dimensions'] | undefined;
  className?: string;
  compact?: boolean;
}) {
  const points = useMemo(() => toRadarPoints(dimensions), [dimensions]);

  const summary = useMemo(() => {
    const covered = points.filter((point) => point.hasValue);
    const average = covered.length
      ? covered.reduce((sum, point) => sum + point.confidence, 0) / covered.length
      : 0;
    const weakest = [...covered]
      .sort((a, b) => a.confidence - b.confidence)
      .slice(0, 3);
    const missing = points.filter((point) => point.missing).map((point) => point.label);
    return { coveredCount: covered.length, average, weakest, missing };
  }, [points]);

  if (!points.length) {
    return (
      <div className={`rounded-2xl border border-slate-200 bg-slate-50/70 p-4 text-sm text-slate-500 ${className}`}>
        暂无维度快照，完成画像访谈或诊断后这里会展示各维度置信度雷达。
      </div>
    );
  }

  const total = points.length;
  const shapePoints = points
    .map((point, index) => {
      const { x, y } = polar(index, total, point.confidence * MAX_RADIUS);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  return (
    <div className={`rounded-2xl border border-slate-200 bg-white ${compact ? 'p-3' : 'p-4'} ${className}`}>
      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div>
          <div className={`font-semibold text-slate-950 ${compact ? 'text-xs' : 'text-sm'}`}>画像维度置信度</div>
          <div className="mt-1 text-xs text-slate-500">
            已覆盖 {summary.coveredCount}/{total} 维 · 平均置信度 {Math.round(summary.average * 100)}%
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5 text-[11px]">
          {(['stable_field', 'stable_field+signals', 'signals', 'missing'] as const).map((basis) => (
            <span key={basis} className="inline-flex items-center gap-1 rounded-full bg-slate-50 px-2 py-1 font-medium text-slate-600">
              <span className="size-2 rounded-full" style={{ backgroundColor: basisMeta(basis).color }} />
              {basisMeta(basis).label}
            </span>
          ))}
        </div>
      </div>

      <div className={compact ? 'mt-3 grid gap-3' : 'mt-3 grid gap-5 md:grid-cols-[minmax(0,380px)_minmax(0,1fr)] md:items-center'}>
        <div className="flex justify-center">
          <svg
            viewBox={VIEW_BOX}
            className={`h-auto w-full ${compact ? 'max-w-[300px]' : 'max-w-[420px]'}`}
            role="img"
            aria-label="画像维度置信度雷达图"
          >
            {/* 背景网格环 */}
            {RINGS.map((ring) => (
              <polygon
                key={ring}
                points={points
                  .map((_, index) => {
                    const { x, y } = polar(index, total, ring * MAX_RADIUS);
                    return `${x.toFixed(1)},${y.toFixed(1)}`;
                  })
                  .join(' ')}
                fill="none"
                stroke="#e2e8f0"
                strokeWidth={1}
              />
            ))}
            {/* 轴线 */}
            {points.map((point, index) => {
              const { x, y } = polar(index, total, MAX_RADIUS);
              return <line key={point.key} x1={CENTER} y1={CENTER} x2={x} y2={y} stroke="#eef2f7" strokeWidth={1} />;
            })}
            {/* 置信度多边形 */}
            <polygon points={shapePoints} fill="rgba(183,121,31,0.13)" stroke="#a16207" strokeWidth={2} strokeLinejoin="round" />
            {/* 顶点（按 basis 配色） */}
            {points.map((point, index) => {
              const { x, y } = polar(index, total, point.confidence * MAX_RADIUS);
              return (
                <circle key={point.key} cx={x} cy={y} r={point.missing ? 2.5 : 3.5} fill={basisMeta(point.basis).color} stroke="#fff" strokeWidth={1}>
                  <title>{`${point.label}：${Math.round(point.confidence * 100)}%（${basisMeta(point.basis).label}）`}</title>
                </circle>
              );
            })}
            {/* 维度标签 */}
            {points.map((point, index) => {
              const { x, y, cos } = polar(index, total, LABEL_RADIUS);
              const anchor = cos > 0.3 ? 'start' : cos < -0.3 ? 'end' : 'middle';
              return (
                <text
                  key={point.key}
                  x={x}
                  y={y}
                  textAnchor={anchor}
                  dominantBaseline="middle"
                  fontSize={9.5}
                  fontWeight={600}
                  fill={point.missing ? '#94a3b8' : '#334155'}
                >
                  {point.label}
                </text>
              );
            })}
          </svg>
        </div>

        <div className="space-y-3">
          <div className="rounded-xl border border-amber-100 bg-amber-50/70 p-3">
            <div className="text-xs font-semibold text-amber-900">最需补强（置信度最低）</div>
            <div className="mt-2 space-y-1.5">
              {summary.weakest.length ? (
                summary.weakest.map((point) => (
                  <div key={point.key} className="flex items-center gap-2">
                    <span className="w-14 shrink-0 text-xs text-amber-900">{point.label}</span>
                    <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-amber-100">
                      <span className="block h-full rounded-full bg-amber-500" style={{ width: `${Math.round(point.confidence * 100)}%` }} />
                    </span>
                    <span className="w-9 shrink-0 text-right text-[11px] font-semibold text-amber-800">
                      {Math.round(point.confidence * 100)}%
                    </span>
                  </div>
                ))
              ) : (
                <div className="text-xs text-amber-800">暂无已覆盖维度</div>
              )}
            </div>
          </div>

          {summary.missing.length > 0 && (
            <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3">
              <div className="text-xs font-semibold text-slate-700">待补充维度</div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {summary.missing.slice(0, compact ? 4 : 14).map((label) => (
                  <span key={label} className="rounded-full bg-white px-2 py-1 text-[11px] font-medium text-slate-500">
                    {label}
                  </span>
                ))}
                {compact && summary.missing.length > 4 && (
                  <span className="rounded-full bg-white px-2 py-1 text-[11px] font-medium text-slate-400">
                    +{summary.missing.length - 4}
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
