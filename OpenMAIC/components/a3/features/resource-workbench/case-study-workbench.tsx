'use client';

import { useMemo, useState } from 'react';
import { BriefcaseBusiness, FileText, LockKeyhole } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { A3ResourcePackV2Resource } from '@/lib/a3/recommendation-types';
import { A3Markdown } from '../../ui/a3-markdown';
import { ResourceLearningRail } from './resource-learning-rail';
import { ResourceWorkbenchShell } from './resource-workbench-shell';
import { normalizeCaseStudy } from './resource-workbench-utils';

type FeedbackAction = 'completed' | 'skipped' | 'favorited';

export function CaseStudyWorkbench({
  resource,
  feedbackMessage,
  feedbackSaving,
  onFeedback,
}: {
  resource: A3ResourcePackV2Resource;
  feedbackMessage: string;
  feedbackSaving: string;
  onFeedback: (action: FeedbackAction, score?: number | null) => void;
}) {
  const caseStudy = useMemo(() => normalizeCaseStudy(resource), [resource]);
  const [judgment, setJudgment] = useState('');
  const [judgmentSubmitted, setJudgmentSubmitted] = useState(false);

  function submitJudgment() {
    if (!judgment.trim()) return;
    setJudgmentSubmitted(true);
  }

  const main = (
    <div className="space-y-5" data-testid="a3-case-study-workbench">
      <section className="rounded-lg border border-blue-200 bg-blue-50 p-5">
        <div className="flex items-center gap-2 text-xs font-semibold text-blue-700">
          <BriefcaseBusiness className="size-4" />
          案例场景
        </div>
        <h2 className="mt-3 text-xl font-semibold text-slate-950">{caseStudy.scenario}</h2>
        <p className="mt-3 text-sm leading-7 text-slate-700">{caseStudy.background}</p>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <ContextItem label="你的角色" value={caseStudy.role} />
          <ContextItem label="核心任务" value={caseStudy.task} />
        </div>
        {caseStudy.constraints.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-2">
            {caseStudy.constraints.map((constraint) => <span key={constraint} className="rounded-full border border-blue-200 bg-white px-3 py-1 text-xs text-blue-800">{constraint}</span>)}
          </div>
        )}
      </section>

      <section>
        <div className="flex items-center gap-2">
          <FileText className="size-4 text-slate-500" />
          <h2 className="text-base font-semibold text-slate-950">案例材料</h2>
        </div>
        <div className="mt-3 grid gap-3 lg:grid-cols-2">
          {caseStudy.materials.map((material) => (
            <article key={`${material.sourceId}-${material.title}`} className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
              <div className="text-xs font-semibold text-blue-700">{material.sourceId}</div>
              <h3 className="mt-1 text-sm font-semibold text-slate-950">{material.title}</h3>
              <p className="mt-2 text-sm leading-6 text-slate-600">{material.snippet}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-base font-semibold text-slate-950">先写下你的判断</h2>
        <p className="mt-2 text-sm leading-6 text-slate-600">{caseStudy.studentPrompt}</p>
        <textarea
          value={judgment}
          onChange={(event) => setJudgment(event.target.value)}
          disabled={judgmentSubmitted}
          placeholder="建议写清楚：你的结论、两个依据、一个仍不确定的条件。"
          className="mt-4 min-h-44 w-full resize-y rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm leading-7 text-slate-800 outline-none transition focus:border-blue-400 focus:bg-white disabled:cursor-default"
        />
        {!judgmentSubmitted && (
          <Button type="button" disabled={!judgment.trim()} onClick={submitJudgment} className="mt-4 bg-blue-600 text-white hover:bg-blue-700">
            提交判断并查看专家拆解
          </Button>
        )}
      </section>

      {judgmentSubmitted ? (
        <section className="rounded-lg border border-amber-200 bg-amber-50 p-5">
          <h2 className="text-base font-semibold text-amber-950">专家拆解</h2>
          <div className="mt-4 space-y-3">
            {caseStudy.analysisSteps.map((step, index) => (
              <div key={`${step}-${index}`} className="grid grid-cols-[28px_minmax(0,1fr)] gap-3">
                <span className="flex size-7 items-center justify-center rounded-md bg-white text-xs font-semibold text-amber-700">{index + 1}</span>
                <p className="text-sm leading-7 text-slate-700">{step}</p>
              </div>
            ))}
          </div>
          <div className="mt-5 border-t border-amber-200 pt-5">
            <h3 className="text-sm font-semibold text-slate-950">参考分析</h3>
            <A3Markdown className="mt-2 text-slate-700">{caseStudy.expertAnalysis}</A3Markdown>
          </div>
          <div className="mt-5 border-t border-amber-200 pt-5">
            <h3 className="text-sm font-semibold text-slate-950">评价标准</h3>
            <ul className="mt-2 grid gap-2 md:grid-cols-2">
              {caseStudy.rubric.map((item) => <li key={item} className="rounded-md bg-white px-3 py-2 text-sm leading-6 text-slate-700">{item}</li>)}
            </ul>
          </div>
        </section>
      ) : (
        <div className="flex items-center gap-2 rounded-lg border border-dashed border-slate-300 bg-slate-50 px-4 py-3 text-sm text-slate-500">
          <LockKeyhole className="size-4" />
          提交自己的判断后，专家拆解与评价标准会在这里展开。
        </div>
      )}
    </div>
  );

  const checkpoints = [
    { label: '阅读场景和材料', completed: true },
    { label: '形成自己的判断', completed: Boolean(judgment.trim()) },
    { label: '对照专家拆解', completed: judgmentSubmitted },
    { label: caseStudy.reflection, completed: false },
  ];

  return (
    <ResourceWorkbenchShell
      main={main}
      rail={(
        <ResourceLearningRail
          resource={resource}
          progress={judgmentSubmitted ? 75 : judgment.trim() ? 45 : 20}
          progressLabel={judgmentSubmitted ? '已进入专家复盘' : '先完成自主判断'}
          steps={caseStudy.decisionPoints.length ? caseStudy.decisionPoints : ['识别约束', '提取证据', '做出判断']}
          checkpoints={checkpoints}
          feedbackMessage={feedbackMessage}
          feedbackSaving={feedbackSaving}
          onFeedback={onFeedback}
          canComplete={judgmentSubmitted}
          completionScore={null}
          completionHint="先提交自己的判断并阅读专家拆解，再记录完成。"
        />
      )}
    />
  );
}

function ContextItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-blue-100 bg-white p-3">
      <div className="text-xs font-semibold text-slate-500">{label}</div>
      <p className="mt-1 text-sm leading-6 text-slate-800">{value}</p>
    </div>
  );
}
