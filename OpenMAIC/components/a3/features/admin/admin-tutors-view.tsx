'use client';

import {
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  CircleHelp,
  Power,
  Server,
  UserRoundCog,
  Volume2,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getA3AdminTutors, updateA3AdminTutor } from '@/lib/a3/admin-api';
import type {
  A3AdminApiResponse,
  A3AdminTutorAssessmentAssociation,
  A3AdminTutorDataStatus,
  A3AdminTutorMetricRow,
  A3AdminTutorPersona,
  A3AdminTutorRange,
  A3AdminTutorsResponse,
  A3AdminTutorUpdateRequest,
  A3TutorMetric,
} from '@/lib/a3/admin-types';
import { cn } from '@/lib/utils';
import { AdminAccessGuard } from './admin-access-guard';
import {
  AdminEmptyState,
  AdminErrorState,
  AdminPageHeader,
  AdminReasonDialog,
  AdminSkeleton,
  AdminStatusBadge,
} from './admin-ui';

type TutorMutation = {
  persona: A3AdminTutorPersona;
  changes: Pick<A3AdminTutorUpdateRequest, 'enabled' | 'avatarAssetId' | 'voicePreviewEnabled'>;
  title: string;
  actionLabel: string;
};

type TutorLicenseStatus = 'complete' | 'incomplete' | 'unknown';

export function createA3AdminTutorRequestCoordinator() {
  let epoch = 0;
  let activeController: AbortController | null = null;
  let running = false;
  const advanceEpoch = () => {
    epoch += 1;
    activeController?.abort();
    activeController = null;
    running = false;
    return epoch;
  };
  return {
    async run<T>(request: (signal: AbortSignal) => Promise<T>, commit: (value: T) => void) {
      const requestEpoch = advanceEpoch();
      const controller = new AbortController();
      activeController = controller;
      running = true;
      try {
        const value = await request(controller.signal);
        if (requestEpoch !== epoch) return false;
        commit(value);
        return true;
      } catch (error) {
        if (requestEpoch !== epoch) return false;
        throw error;
      } finally {
        if (requestEpoch === epoch) {
          running = false;
          activeController = null;
        }
      }
    },
    isRunning() {
      return running;
    },
    beginMutation() {
      advanceEpoch();
    },
    invalidate() {
      advanceEpoch();
    },
  };
}

export function isA3AdminTutorConflict(result: A3AdminApiResponse) {
  return !result.success && result.status === 409 && result.errorCode === 'stale_update';
}

export function AdminTutorsView() {
  return (
    <AdminAccessGuard>
      <AdminTutorsContent />
    </AdminAccessGuard>
  );
}

function AdminTutorsContent() {
  const [range, setRange] = useState<A3AdminTutorRange>('30d');
  const [data, setData] = useState<A3AdminTutorsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [mutation, setMutation] = useState<TutorMutation | null>(null);
  const [mutationPending, setMutationPending] = useState(false);
  const [mutationError, setMutationError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const coordinator = useRef(createA3AdminTutorRequestCoordinator());
  const mutationInFlight = useRef(false);
  const mountedRef = useRef(false);

  useEffect(() => {
    const requestCoordinator = coordinator.current;
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestCoordinator.invalidate();
    };
  }, []);

  const load = useCallback(async ({ silent = false }: { silent?: boolean } = {}) => {
    if (!mountedRef.current || mutationInFlight.current) return false;
    if (silent && coordinator.current.isRunning()) return false;
    if (!silent) {
      setLoading(true);
      setError('');
    }
    try {
      await coordinator.current.run(
        (signal) => getA3AdminTutors(range, { signal }),
        (result) => {
          if (!mountedRef.current) return;
          if (result.success) setData(result);
          else if (!silent) setError(result.error || '导师运行数据加载失败，请稍后重试。');
          if (!silent) setLoading(false);
        },
      );
      return mountedRef.current;
    } catch {
      if (!mountedRef.current) return false;
      if (!silent) {
        setError('导师运行数据加载失败，请稍后重试。');
        setLoading(false);
      }
      return false;
    }
  }, [range]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') void load({ silent: true });
    };
    const interval = window.setInterval(refreshWhenVisible, 30_000);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [load]);

  async function executeMutation(reason: string) {
    if (!mutation) return;
    if (!mutation.persona.updatedAt) {
      setMutation(null);
      setMutationError('当前配置缺少更新时间，请刷新后再操作。');
      return;
    }
    mutationInFlight.current = true;
    coordinator.current.beginMutation();
    setMutationPending(true);
    setMutationError('');
    setSuccessMessage('');
    let reloadAfterMutation = false;
    try {
      const result = await updateA3AdminTutor(mutation.persona.id, {
        ...mutation.changes,
        reason,
        expectedUpdatedAt: mutation.persona.updatedAt,
      });
      if (!mountedRef.current) return;
      if (!result.success || !result.persona) {
        setMutation(null);
        if (isA3AdminTutorConflict(result)) {
          setMutationError('配置已发生并发变更，已刷新最新数据，请重新操作。');
          reloadAfterMutation = true;
        } else {
          setMutationError(result.error || '导师配置更新失败，请重试。');
        }
        return;
      }

      const savedPersona = result.persona;
      setData((current) => current ? replaceSavedPersona(current, savedPersona) : current);
      setMutation(null);
      setSuccessMessage(`${savedPersona.name}的运行配置已保存。`);
    } catch {
      if (!mountedRef.current) return;
      setMutation(null);
      setMutationError('导师配置更新失败，请重试。');
    } finally {
      mutationInFlight.current = false;
      if (mountedRef.current) {
        setMutationPending(false);
        if (reloadAfterMutation && mountedRef.current) await load();
      }
    }
  }

  return (
    <div className="min-w-0 space-y-5" data-testid="a3-admin-tutors">
      <AdminPageHeader
        title="导师管理"
        refreshing={loading || mutationPending}
        onRefresh={() => void load()}
        actions={(
          <TutorRangeControl
            value={range}
            disabled={mutationPending}
            onChange={setRange}
          />
        )}
      />

      <div className="min-h-6" aria-live="polite">
        {successMessage ? (
          <p role="status" className="flex items-center gap-2 text-sm text-emerald-800">
            <CheckCircle2 className="size-4 shrink-0" aria-hidden="true" />
            <span className="break-words">{successMessage}</span>
          </p>
        ) : null}
        {mutationError ? (
          <p role="alert" className="flex items-start gap-2 text-sm text-rose-700">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span className="break-words">{mutationError}</span>
          </p>
        ) : null}
      </div>

      {error && !data ? <AdminErrorState message={error} onRetry={() => void load()} /> : null}
      {loading && !data ? <AdminSkeleton rows={7} /> : null}

      {data ? (
        <>
          {error ? <AdminErrorState message={error} onRetry={() => void load()} /> : null}
          <TutorKpis data={data} />

          <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1.65fr)_minmax(300px,0.75fr)]">
            <PersonaTable
              data={data}
              disabled={loading || mutationPending}
              onMutate={setMutation}
            />
            <AssetAndProviderStatus data={data} />
          </div>

          <TutorAnalytics data={data} />
        </>
      ) : null}

      <AdminReasonDialog
        open={Boolean(mutation)}
        title={mutation?.title || '更新导师配置'}
        actionLabel={mutation?.actionLabel || '确认保存'}
        pending={mutationPending}
        onClose={() => { if (!mutationPending) setMutation(null); }}
        onConfirm={executeMutation}
      />
    </div>
  );
}

function TutorRangeControl({
  value,
  disabled,
  onChange,
}: {
  value: A3AdminTutorRange;
  disabled: boolean;
  onChange: (value: A3AdminTutorRange) => void;
}) {
  return (
    <div
      className="flex h-9 items-center rounded-md border border-[#c8c3b4] bg-[#fffdf7] p-0.5"
      role="group"
      aria-label="统计周期"
    >
      {(['7d', '30d', '90d'] as const).map((item) => (
        <button
          key={item}
          type="button"
          aria-pressed={value === item}
          disabled={disabled}
          onClick={() => onChange(item)}
          className={cn(
            'h-7 min-w-11 rounded px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#9b7b2f] disabled:cursor-not-allowed disabled:opacity-50',
            value === item
              ? 'bg-[#143f32] text-[#fffdf7]'
              : 'text-[#52645d] hover:bg-[#f0ede3]',
          )}
        >
          {item.slice(0, -1)} 天
        </button>
      ))}
    </div>
  );
}

function TutorKpis({ data }: { data: A3AdminTutorsResponse }) {
  const hasPersonas = data.personas.length > 0;
  const personaSampleCount = data.personas.filter(
    (item) => item.configurationDataStatus === 'collected',
  ).length;
  const personaStatus: A3AdminTutorDataStatus = !hasPersonas
    ? 'not_collected'
    : personaSampleCount === data.personas.length
    ? 'collected'
    : personaSampleCount > 0
      ? 'partial'
      : 'not_collected';
  const kpis = [
    {
      label: '启用人格',
      value: formatMetricByStatus(
        personaStatus,
        hasPersonas ? data.kpis.enabledPersonaCount : null,
        String,
      ),
      status: personaStatus,
      sampleCount: personaSampleCount,
    },
    {
      label: '辅导会话',
      value: data.kpis.sessionCount.toLocaleString('zh-CN'),
      status: 'collected' as const,
      sampleCount: data.kpis.sessionCount,
    },
    {
      label: '引用验证率',
      value: formatMetricByStatus(
        data.kpis.verifiedResponseRate.dataStatus,
        data.kpis.verifiedResponseRate.value,
        formatCollectedRate,
      ),
      status: data.kpis.verifiedResponseRate.dataStatus,
      sampleCount: metricSampleCount(data.kpis.verifiedResponseRate),
    },
    {
      label: '满意度',
      value: formatMetricByStatus(
        data.kpis.satisfaction.dataStatus,
        data.kpis.satisfaction.value,
        (value) => `${value.toFixed(1)} / 5`,
      ),
      status: data.kpis.satisfaction.dataStatus,
      sampleCount: metricSampleCount(data.kpis.satisfaction),
    },
  ];

  return (
    <section
      className="grid grid-cols-1 overflow-hidden rounded-md border border-[#d9d6c9] bg-[#d9d6c9] sm:grid-cols-2 xl:grid-cols-4"
      aria-label="导师核心指标"
    >
      {kpis.map((kpi) => (
        <div key={kpi.label} className="min-w-0 bg-[#fffdf7] p-4">
          <p className="truncate text-xs font-medium text-[#64736c]">{kpi.label}</p>
          <p className="mt-2 break-words text-2xl font-semibold tabular-nums text-[#143f32]">
            {kpi.value}
          </p>
          <TutorMetricEvidence dataStatus={kpi.status} sampleCount={kpi.sampleCount} />
        </div>
      ))}
    </section>
  );
}

function PersonaTable({
  data,
  disabled,
  onMutate,
}: {
  data: A3AdminTutorsResponse;
  disabled: boolean;
  onMutate: (mutation: TutorMutation) => void;
}) {
  const enabledAssets = data.assets.filter((asset) => asset.status === 'enabled');
  return (
    <section className="min-w-0 border-y border-[#d9d6c9] bg-[#fffdf7]">
      <div className="flex items-center gap-2 px-4 py-3">
        <UserRoundCog className="size-4 shrink-0 text-[#9b7b2f]" aria-hidden="true" />
        <h2 className="text-sm font-semibold text-[#143f32]">人格运行配置</h2>
      </div>
      {!data.personas.length ? (
        <AdminEmptyState title="尚未登记导师人格配置" />
      ) : (
        <div className="min-w-0 overflow-x-auto border-t border-[#e3dfd3]">
          <table className="w-full min-w-[820px] border-collapse text-left text-sm">
            <thead className="bg-[#f0ede3] text-xs text-[#64736c]">
              <tr>
                <Th>导师人格</Th>
                <Th>运行状态</Th>
                <Th>VRM 资产</Th>
                <Th>音色试听</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#e3dfd3]">
              {data.personas.map((persona) => {
                const unavailable = disabled
                  || persona.configurationDataStatus !== 'collected'
                  || !persona.updatedAt;
                return (
                  <tr key={persona.id} className="align-top hover:bg-[#faf5df]">
                    <Td>
                      <div className="max-w-[320px] min-w-0">
                        <p className="break-words font-semibold text-[#244a3d]">{persona.name}</p>
                        <p className="mt-1 break-words text-xs leading-5 text-[#64736c]">
                          {persona.shortDescription}
                        </p>
                      </div>
                    </Td>
                    <Td>
                      <button
                        type="button"
                        disabled={unavailable}
                        title={persona.enabled ? '停用该导师人格' : '启用该导师人格'}
                        onClick={() => onMutate({
                          persona,
                          changes: { enabled: !persona.enabled },
                          title: `${persona.enabled ? '停用' : '启用'}${persona.name}`,
                          actionLabel: '确认变更',
                        })}
                        className="inline-flex h-8 items-center gap-2 rounded-md border border-[#c8c3b4] px-2.5 text-xs font-medium text-[#244a3d] hover:bg-[#f0ede3] disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <Power className="size-3.5" aria-hidden="true" />
                        {persona.enabled ? '已启用' : persona.enabled === false ? '已停用' : '未采集'}
                      </button>
                    </Td>
                    <Td>
                      <label className="block min-w-44">
                        <span className="sr-only">{persona.name}的 VRM 资产</span>
                        <select
                          aria-label={`${persona.name}的 VRM 资产`}
                          value={persona.avatarAssetId || ''}
                          disabled={unavailable || !enabledAssets.length}
                          onChange={(event) => onMutate({
                            persona,
                            changes: { avatarAssetId: event.target.value },
                            title: `更新${persona.name}的 VRM 资产`,
                            actionLabel: '确认绑定',
                          })}
                          className="h-8 w-full max-w-56 rounded-md border border-[#c8c3b4] bg-white px-2 text-xs text-[#244a3d] outline-none focus:border-[#9b7b2f] disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {!persona.avatarAssetId ? <option value="">未绑定</option> : null}
                          {enabledAssets.map((asset) => (
                            <option key={asset.assetId} value={asset.assetId}>{asset.assetId}</option>
                          ))}
                        </select>
                      </label>
                    </Td>
                    <Td>
                      <button
                        type="button"
                        disabled={unavailable}
                        title={persona.voicePreviewEnabled ? '关闭音色试听' : '开启音色试听'}
                        onClick={() => onMutate({
                          persona,
                          changes: { voicePreviewEnabled: !persona.voicePreviewEnabled },
                          title: `${persona.voicePreviewEnabled ? '关闭' : '开启'}${persona.name}的音色试听`,
                          actionLabel: '确认变更',
                        })}
                        className="inline-flex h-8 items-center gap-2 rounded-md border border-[#c8c3b4] px-2.5 text-xs font-medium text-[#244a3d] hover:bg-[#f0ede3] disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <Volume2 className="size-3.5" aria-hidden="true" />
                        {persona.voicePreviewEnabled ? '可试听' : '不可试听'}
                      </button>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function AssetAndProviderStatus({ data }: { data: A3AdminTutorsResponse }) {
  return (
    <aside className="min-w-0 space-y-5">
      <section className="min-w-0 border-y border-[#d9d6c9] bg-[#fffdf7]">
        <h2 className="px-4 py-3 text-sm font-semibold text-[#143f32]">VRM 资产状态</h2>
        {!data.assets.length ? (
          <AdminEmptyState title="尚未登记可用 VRM 资产" />
        ) : (
          <div className="divide-y divide-[#e3dfd3] border-t border-[#e3dfd3]">
            {data.assets.map((asset) => {
              const license = tutorLicenseStatus(asset.licenseComplete);
              return (
                <div key={asset.assetId} className="min-w-0 px-4 py-3">
                  <div className="flex min-w-0 items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="break-words text-sm font-medium text-[#244a3d]">{asset.assetId}</p>
                      <p className="mt-1 text-xs text-[#64736c]">
                        {formatFileSize(asset.fileSizeBytes)}{asset.isDefault ? ' · 默认资产' : ''}
                      </p>
                    </div>
                    <AdminStatusBadge status={asset.status} />
                  </div>
                  <div className="mt-2 flex items-center gap-2 text-xs text-[#64736c]">
                    <LicenseIcon status={license} />
                    <span>license: {license}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="min-w-0 border-y border-[#d9d6c9] bg-[#fffdf7]">
        <div className="flex items-center gap-2 px-4 py-3">
          <Server className="size-4 shrink-0 text-[#9b7b2f]" aria-hidden="true" />
          <h2 className="text-sm font-semibold text-[#143f32]">试听服务</h2>
        </div>
        {!data.providerStatus.length ? (
          <AdminEmptyState title="尚未采集试听服务状态" />
        ) : (
          <div className="divide-y divide-[#e3dfd3] border-t border-[#e3dfd3]">
            {data.providerStatus.map((item, index) => (
              <div key={`${item.id}-${index}`} className="flex min-w-0 items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-[#244a3d]">语音试听服务</p>
                  <TutorMetricEvidence dataStatus={item.dataStatus} />
                </div>
                <AdminStatusBadge status={item.status} />
              </div>
            ))}
          </div>
        )}
      </section>
    </aside>
  );
}

function TutorAnalytics({ data }: { data: A3AdminTutorsResponse }) {
  return (
    <div className="min-w-0 space-y-5">
      <AdoptionBand data={data} />
      <MetricBand
        title="会话质量"
        icon={<BarChart3 className="size-4" aria-hidden="true" />}
        rows={data.analytics.sessionQuality}
      />
      <MetricBand
        title="学生反馈聚合"
        icon={<Volume2 className="size-4" aria-hidden="true" />}
        rows={data.analytics.feedback}
      />
      <AssessmentBand value={data.analytics.assessmentAssociation} />
    </div>
  );
}

function AdoptionBand({ data }: { data: A3AdminTutorsResponse }) {
  const sampleCount = data.analytics.adoption.reduce((sum, item) => sum + (item.denominator || 0), 0);
  const status = combinedDataStatus(data.analytics.adoption.map((item) => item.dataStatus));
  return (
    <section className="min-w-0 border-y border-[#d9d6c9] bg-[#fffdf7] px-4 py-4">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-[#143f32]">人格采用趋势</h2>
          <TutorMetricEvidence dataStatus={status} sampleCount={sampleCount} />
        </div>
        <span className="text-xs text-[#64736c]">{data.range.replace('d', ' 天')}</span>
      </div>
      {sampleCount === 0 ? (
        <div className="mt-3"><AdminEmptyState title="该周期暂无人格辅导会话" /></div>
      ) : (
        <div className="mt-4 min-w-0 overflow-x-auto">
          <div
            className="flex h-32 min-w-[680px] items-end gap-1 border-b border-[#d9d6c9]"
            role="img"
            aria-describedby="a3-tutor-adoption-trend-details"
            aria-label={`人格采用趋势，共 ${sampleCount} 个会话样本`}
          >
            {data.analytics.adoption.map((point) => (
              <span
                key={point.date}
                title={`${point.date} · ${formatMetricByStatus(point.dataStatus, point.value, formatCollectedRate)} · 样本 ${point.denominator || 0}`}
                className="min-w-1 flex-1 bg-[#6f8d78]"
                style={{
                  height: point.dataStatus === 'collected' && point.value !== null
                    ? `${Math.max(6, point.value * 100)}%`
                    : '0%',
                }}
              />
            ))}
          </div>
        </div>
      )}
      <table id="a3-tutor-adoption-trend-details" className="sr-only">
        <caption>人格采用趋势每日明细</caption>
        <thead>
          <tr><th>date</th><th>rate</th><th>sampleCount</th><th>dataStatus</th></tr>
        </thead>
        <tbody>
          {data.analytics.adoption.map((point) => (
            <tr key={point.date}>
              <td>{point.date}</td>
              <td>{formatMetricByStatus(point.dataStatus, point.value, formatCollectedRate)}</td>
              <td>{point.denominator || 0}</td>
              <td>{point.dataStatus}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function MetricBand({
  title,
  icon,
  rows,
}: {
  title: string;
  icon: React.ReactNode;
  rows: A3AdminTutorMetricRow[];
}) {
  return (
    <section className="min-w-0 border-y border-[#d9d6c9] bg-[#fffdf7]">
      <div className="flex items-center gap-2 px-4 py-3 text-[#9b7b2f]">
        {icon}
        <h2 className="text-sm font-semibold text-[#143f32]">{title}</h2>
      </div>
      {!rows.length ? (
        <AdminEmptyState title={`暂无${title}数据`} />
      ) : (
        <div className="grid grid-cols-1 border-t border-[#e3dfd3] sm:grid-cols-2 xl:grid-cols-4">
          {rows.map((row) => (
            <div key={row.metric} className="min-w-0 border-b border-[#e3dfd3] p-4 sm:border-r">
              <p className="break-words text-xs font-medium text-[#64736c]">{metricLabel(row.metric)}</p>
              <p className="mt-2 break-words text-lg font-semibold tabular-nums text-[#143f32]">
                {formatMetricRow(row)}
              </p>
              <TutorMetricEvidence
                dataStatus={row.dataStatus}
                sampleCount={metricSampleCount(row)}
              />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function AssessmentBand({ value }: { value: A3AdminTutorAssessmentAssociation }) {
  const unavailableState = metricUnavailableLabel(value.dataStatus);
  return (
    <section className="min-w-0 border-y border-[#d9d6c9] bg-[#fffdf7] px-4 py-4">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-[#143f32]">辅导后测评关联</h2>
          <TutorMetricEvidence dataStatus={value.dataStatus} sampleCount={value.pairCount} />
        </div>
        <p className="max-w-full break-words text-xs text-[#8a651f]">
          观察到的相关性，不代表因果关系
        </p>
      </div>
      {unavailableState ? (
        <div className="mt-4 flex min-h-24 items-center justify-center border-t border-[#e3dfd3] text-sm text-[#64736c]">
          {unavailableState}，暂不展示分数变化。
        </div>
      ) : (
        <div className="mt-4 grid grid-cols-1 gap-px overflow-hidden rounded-md bg-[#d9d6c9] sm:grid-cols-4">
          <AssociationCell label="平均变化" value={value.averageDelta === null ? '暂无数据' : `${value.averageDelta > 0 ? '+' : ''}${value.averageDelta.toFixed(1)}`} />
          <AssociationCell label="正向" value={String(value.positiveCount)} />
          <AssociationCell label="持平" value={String(value.flatCount)} />
          <AssociationCell label="负向" value={String(value.negativeCount)} />
        </div>
      )}
    </section>
  );
}

function TutorMetricEvidence({
  dataStatus,
  sampleCount,
}: {
  dataStatus: A3AdminTutorDataStatus;
  sampleCount?: number;
}) {
  return (
    <p className="mt-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-[#64736c]">
      <span>dataStatus: {dataStatus}</span>
      <span>{metricStateLabel(dataStatus)}</span>
      {sampleCount !== undefined ? <span>sampleCount: {sampleCount}</span> : null}
    </p>
  );
}

function LicenseIcon({ status }: { status: TutorLicenseStatus }) {
  if (status === 'complete') {
    return <span title="许可证资料完整" aria-label="许可证资料完整"><CheckCircle2 className="size-3.5 text-emerald-700" aria-hidden="true" /></span>;
  }
  if (status === 'incomplete') {
    return <span title="许可证资料不完整" aria-label="许可证资料不完整"><AlertTriangle className="size-3.5 text-amber-700" aria-hidden="true" /></span>;
  }
  return <span title="许可证资料状态未知" aria-label="许可证资料状态未知"><CircleHelp className="size-3.5 text-stone-500" aria-hidden="true" /></span>;
}

function AssociationCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 bg-[#fffdf7] p-3">
      <p className="text-xs text-[#64736c]">{label}</p>
      <p className="mt-1 break-words text-lg font-semibold tabular-nums text-[#143f32]">{value}</p>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="whitespace-nowrap px-3 py-2.5 font-medium">{children}</th>;
}

function Td({ children }: { children: React.ReactNode }) {
  return <td className="px-3 py-3 text-[#40554c]">{children}</td>;
}

function tutorLicenseStatus(value: boolean | null): TutorLicenseStatus {
  if (value === true) return 'complete';
  if (value === false) return 'incomplete';
  return 'unknown';
}

function replaceSavedPersona(data: A3AdminTutorsResponse, persona: A3AdminTutorPersona) {
  const personas = data.personas.map((item) => item.id === persona.id ? persona : item);
  return {
    ...data,
    personas,
    kpis: {
      ...data.kpis,
      enabledPersonaCount: personas.filter((item) => item.enabled === true).length,
    },
  };
}

function metricSampleCount(metric: A3TutorMetric<number> & { values?: Array<{ sessionCount: number }> }) {
  if (metric.values) return metric.values.reduce((sum, item) => sum + item.sessionCount, 0);
  return metric.sampleCount ?? metric.denominator ?? 0;
}

function combinedDataStatus(statuses: A3AdminTutorDataStatus[]): A3AdminTutorDataStatus {
  if (!statuses.length || statuses.every((status) => status === 'not_collected')) return 'not_collected';
  if (statuses.every((status) => status === 'collected')) return 'collected';
  return 'partial';
}

function formatCollectedRate(value: number) {
  return `${(value * 100).toFixed(1)}%`;
}

function formatMetricRow(row: A3AdminTutorMetricRow) {
  const unavailableState = metricUnavailableLabel(row.dataStatus);
  if (unavailableState) return unavailableState;
  if (row.values) {
    const total = row.values.reduce((sum, item) => sum + item.sessionCount, 0);
    return `${total} 次会话`;
  }
  if (row.value === null) return '未采集';
  if (/Rate|coverage/i.test(row.metric)) return formatCollectedRate(row.value);
  if (row.metric === 'satisfaction') return `${row.value.toFixed(1)} / 5`;
  return row.value.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}

function formatMetricByStatus<T>(
  dataStatus: A3AdminTutorDataStatus,
  value: T | null,
  formatter: (value: T) => string,
) {
  const unavailableState = metricUnavailableLabel(dataStatus);
  if (unavailableState) return unavailableState;
  return value === null ? '未采集' : formatter(value);
}

function metricUnavailableLabel(dataStatus: A3AdminTutorDataStatus) {
  if (dataStatus === 'not_collected') return '未采集';
  if (dataStatus === 'insufficient_sample') return '样本不足';
  if (dataStatus === 'partial') return '数据不完整';
  return '';
}

function metricStateLabel(dataStatus: A3AdminTutorDataStatus) {
  return metricUnavailableLabel(dataStatus) || '已采集';
}

function metricLabel(metric: string) {
  const labels: Record<string, string> = {
    perPersonaSessionCount: '人格会话数',
    averageStudentMessageTurns: '平均追问轮次',
    verifiedAssistantResponseRate: '引用验证率',
    normalEndedRate: '正常结束率',
    runtimeFallbackRate: '运行降级率',
    satisfaction: '满意度',
    coverage: '反馈覆盖率',
  };
  return labels[metric] || metric;
}

function formatFileSize(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '文件大小未知';
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.ceil(value / 1024)} KB`;
}
