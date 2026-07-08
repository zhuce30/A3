import { Bot, CheckCircle2 } from 'lucide-react';
import { A3Pill } from './a3-card';

export type AgentDecisionEvidenceItem = {
  agent: string;
  input: string;
  output: string;
  evidence?: string;
};

export function AgentDecisionEvidence({
  title = 'Agent 决策证据',
  items,
  compact = false,
}: {
  title?: string;
  items: AgentDecisionEvidenceItem[];
  compact?: boolean;
}) {
  const visibleItems = items.filter((item) => item.input || item.output || item.evidence);
  if (!visibleItems.length) return null;

  return (
    <div className="rounded-2xl border border-blue-100 bg-blue-50/70 p-4" data-testid="a3-agent-decision-evidence">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-blue-950">
          <Bot className="size-4 text-blue-700" />
          {title}
        </div>
        <A3Pill tone="blue">{visibleItems.length} 个 Agent</A3Pill>
      </div>
      <div className={compact ? 'mt-3 space-y-2' : 'mt-3 grid gap-3 md:grid-cols-2'}>
        {visibleItems.map((item) => (
          <div key={`${item.agent}-${item.output}`} className="rounded-xl bg-white/85 p-3 text-xs leading-5 text-blue-900">
            <div className="flex items-center gap-2 font-semibold text-blue-950">
              <CheckCircle2 className="size-3.5 text-blue-700" />
              {item.agent}
            </div>
            <div className="mt-2">
              <span className="font-semibold">输入：</span>
              {item.input || '当前学生数据'}
            </div>
            <div>
              <span className="font-semibold">输出：</span>
              {item.output || '个性化学习决策'}
            </div>
            {item.evidence && (
              <div className="mt-1 text-blue-700">
                <span className="font-semibold">证据：</span>
                {item.evidence}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
