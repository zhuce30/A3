// 自包含的资源生成 hook：任何界面都能用当前 goal + 资源类型触发一次真实生成。
// 复用后端通用 job 接口（POST /api/a3/resources/jobs -> 轮询 pollUrl），不依赖 recommendations
// 页面的进度 UI 结构。课堂 A（显式 chips）和 B（对话触发）共用它。
'use client';

import { useCallback, useRef, useState } from 'react';
import type { A3ResourcePackV2, A3ResourcePackV2ResourceType, A3ResourceGenerateResponse } from '@/lib/a3/recommendation-types';
import { hasMojibake } from '@/lib/a3/mojibake';

type JobResponse = A3ResourceGenerateResponse & {
  pollUrl?: string;
  pollIntervalMs?: number;
  status?: string;
  progress?: number;
  stage?: string;
  message?: string;
  done?: boolean;
};

export type ResourceGenerationState = {
  generating: boolean;
  activeType: A3ResourcePackV2ResourceType | null;
  progress: number;
  stage: string;
  error: string;
};

const IDLE: ResourceGenerationState = { generating: false, activeType: null, progress: 0, stage: '', error: '' };

function sanitizeText(value: unknown, fallback: string): string {
  const text = typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
  return !text || hasMojibake(text) ? fallback : text;
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === 'string') return sanitizeText(value, '内容已生成');
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, sanitizeValue(v)]));
  }
  return value;
}

function sanitizePack(pack: A3ResourcePackV2): A3ResourcePackV2 {
  return {
    ...pack,
    goal: sanitizeText(pack.goal, '当前学习目标'),
    resources: (pack.resources ?? []).map((resource) => ({
      ...resource,
      title: sanitizeText(resource.title, '学习资源'),
      content: sanitizeValue(resource.content ?? {}) as Record<string, unknown>,
      personalizationReason: sanitizeText(resource.personalizationReason, '根据当前画像与知识库证据生成。'),
    })),
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function postJson<T extends { success: boolean; error?: string }>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  try {
    return (await response.json()) as T;
  } catch {
    return { success: false, error: '资源生成任务返回了非 JSON 响应。' } as T;
  }
}

export function useResourceGeneration() {
  const [state, setState] = useState<ResourceGenerationState>(IDLE);
  // 用 ref 防止并发生成互相踩状态。
  const runningRef = useRef(false);

  const generate = useCallback(
    async (resourceType: A3ResourcePackV2ResourceType, goal: string): Promise<A3ResourcePackV2 | null> => {
      const trimmedGoal = goal.trim();
      if (!trimmedGoal) {
        setState({ ...IDLE, error: '请先确定学习目标再生成资源。' });
        return null;
      }
      if (runningRef.current) return null;
      runningRef.current = true;
      setState({ generating: true, activeType: resourceType, progress: 5, stage: '正在检索相关课程资料', error: '' });

      const start = await postJson<JobResponse>('/api/a3/resources/jobs', { goal: trimmedGoal, topK: 5, resourceType });
      if (!start.success) {
        runningRef.current = false;
        setState({ ...IDLE, error: start.error ?? '资源生成任务启动失败。' });
        return null;
      }

      const pollUrl = typeof start.pollUrl === 'string' && start.pollUrl.startsWith('/api/') ? start.pollUrl : null;
      // 无 pollUrl 说明后端已同步返回结果（少数快路径）。
      let finished: JobResponse | null = pollUrl ? null : start;

      if (pollUrl) {
        const intervalMs = Math.max(800, Math.min(start.pollIntervalMs ?? 1500, 4000));
        const maxAttempts = Math.ceil((30 * 60 * 1000) / intervalMs);
        let transientFailures = 0;
        for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
          await sleep(attempt === 0 ? 300 : intervalMs);
          let job: JobResponse;
          try {
            const response = await fetch(pollUrl, { cache: 'no-store', signal: AbortSignal.timeout(12_000) });
            job = (await response.json()) as JobResponse;
          } catch {
            transientFailures += 1;
            if (transientFailures >= 5) {
              runningRef.current = false;
              setState({ ...IDLE, error: '生成进度查询多次失败，请稍后重试。' });
              return null;
            }
            continue;
          }
          transientFailures = 0;
          if (typeof job.progress === 'number' || job.stage || job.message) {
            setState((prev) => ({
              ...prev,
              progress: typeof job.progress === 'number' ? job.progress : prev.progress,
              stage: job.stage || job.message || prev.stage,
            }));
          }
          const status = String(job.status ?? '').toLowerCase();
          if (job.done || status === 'succeeded' || status === 'failed' || job.resourcePack || job.error) {
            finished = job;
            break;
          }
        }
      }

      runningRef.current = false;
      if (!finished || !finished.success || !finished.resourcePack) {
        setState({ ...IDLE, error: finished?.error ?? '资源生成失败或超时。' });
        return null;
      }
      const pack = sanitizePack(finished.resourcePack);
      setState({ generating: false, activeType: null, progress: 100, stage: '已生成', error: '' });
      return pack;
    },
    [],
  );

  const reset = useCallback(() => setState(IDLE), []);

  return { ...state, generate, reset };
}
