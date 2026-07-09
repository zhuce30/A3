'use client';

import Link from 'next/link';
import { ArrowRight, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  pendingProfileUpdateCount,
  profileDimensionLabel,
  profileSourceLabel,
  profileStatusLabel,
  summarizeProfileTimelineEntry,
  summarizeProfileUpdateEvidence,
  type DynamicProfileFeedResponse,
  type ProfileTimelineEntry,
} from '@/lib/a3/profile-timeline';

export function ProfileUpdateCandidatePanel({
  feed,
  title = '本次学习让画像发生了变化',
  subtitle = '系统已经根据新的学习行为生成画像候选，确认后会影响今日任务、学习计划和推荐排序。',
  limit = 3,
  profileHref = '/a3/profile-setup',
  testId = 'a3-flow-profile-candidates',
}: {
  feed: DynamicProfileFeedResponse | null;
  title?: string;
  subtitle?: string;
  limit?: number;
  profileHref?: string;
  testId?: string;
}) {
  const pending = feed?.confirmationQueue?.filter((item) => item.status === 'pending') ?? [];
  const recent = pending.length ? pending : (feed?.timeline ?? []).slice(0, limit);
  const count = pendingProfileUpdateCount(feed);

  if (!recent.length) return null;

  return (
    <section data-testid={testId} className="rounded-2xl border border-orange-100 bg-orange-50/80 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Sparkles className="size-4 text-orange-700" />
            <h3 className="text-sm font-semibold text-orange-950">{title}</h3>
          </div>
          <p className="mt-1 max-w-[70ch] text-xs leading-5 text-orange-800">{subtitle}</p>
        </div>
        <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-orange-700">
          {count ? `${count} 条待确认` : profileStatusLabel(recent[0]?.status)}
        </span>
      </div>

      <div className="mt-3 grid gap-2">
        {recent.slice(0, limit).map((item) => (
          <ProfileUpdateCandidateItem key={`${item.id}-${item.versionId || item.createdAt}`} item={item} />
        ))}
      </div>

      <Button asChild size="sm" variant="outline" className="mt-3 border-orange-200 bg-white text-orange-800 hover:bg-orange-50">
        <Link href={profileHref}>
          查看画像变化
          <ArrowRight className="size-4" />
        </Link>
      </Button>
    </section>
  );
}

function ProfileUpdateCandidateItem({ item }: { item: ProfileTimelineEntry }) {
  return (
    <div className="rounded-xl bg-white/85 px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-orange-100 px-2 py-0.5 text-[11px] font-semibold text-orange-800">
          {profileDimensionLabel(item.changedDimensions?.[0] || '')}
        </span>
        <span className="text-[11px] font-medium text-orange-700">{profileSourceLabel(item.source)}</span>
        <span className="text-[11px] text-orange-700">置信度 {Math.round((item.confidence ?? 0) * 100)}%</span>
      </div>
      <p className="mt-1 text-sm leading-6 text-slate-800">{summarizeProfileTimelineEntry(item)}</p>
      <p className="mt-1 text-xs leading-5 text-slate-500">{summarizeProfileUpdateEvidence(item)}</p>
    </div>
  );
}
