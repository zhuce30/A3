'use client';

import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, CheckSquare2, Code2, Copy, Download, Loader2, Pencil, Play, RotateCcw, TerminalSquare, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { a3PostJson } from '@/lib/a3/api-client';
import type { A3ResourcePackV2Resource } from '@/lib/a3/recommendation-types';
import { highlightCode } from '@/components/ai-elements/code-block';
import { RailSection, ResourceLearningRail } from './resource-learning-rail';
import { ResourceWorkbenchShell } from './resource-workbench-shell';
import { normalizeCodeLab } from './resource-workbench-utils';

type FeedbackAction = 'completed' | 'skipped' | 'favorited';

type CodeLabRunResult = {
  status: string;
  mode: string;
  provider?: string;
  stdout?: string;
  stderr?: string;
  durationMs?: number;
  error?: string;
  passedCount?: number;
  totalCount?: number;
  testResults?: Array<{
    name: string;
    passed: boolean;
    status: string;
    expectedStdout: string;
    actualStdout: string;
    stderr?: string;
    error?: string;
  }>;
};

type CodeLabRunResponse = {
  success: boolean;
  error?: string;
  result?: CodeLabRunResult;
};

export function CodeLabWorkbench({
  resource,
  packId,
  feedbackMessage,
  feedbackSaving,
  onFeedback,
}: {
  resource: A3ResourcePackV2Resource;
  packId: string;
  feedbackMessage: string;
  feedbackSaving: string;
  onFeedback: (action: FeedbackAction, score?: number | null) => void;
}) {
  const lab = useMemo(() => normalizeCodeLab(resource), [resource]);
  const [code, setCode] = useState(lab.starterCode);
  const [stdin, setStdin] = useState('');
  const [runningMode, setRunningMode] = useState<'run' | 'judge' | ''>('');
  const [runResult, setRunResult] = useState<CodeLabRunResult | null>(null);
  const [runError, setRunError] = useState('');
  const [checked, setChecked] = useState<Set<number>>(() => new Set());
  const [copyMessage, setCopyMessage] = useState('');
  // 默认展示高亮预览（学生读起始代码是主要场景），点"编辑"切到可写 textarea。
  const [editing, setEditing] = useState(false);
  const completion = lab.checkpoints.length ? Math.round((checked.size / lab.checkpoints.length) * 100) : 0;
  const executionPassed = runResult?.status === 'passed' && (lab.testCases.length === 0 || runResult.mode === 'judge');
  const checkpointsComplete = lab.checkpoints.length === 0 || checked.size === lab.checkpoints.length;
  const canComplete = Boolean(executionPassed && checkpointsComplete);
  const completionScore = runResult?.mode === 'judge' && runResult.totalCount
    ? Math.round(((runResult.passedCount ?? 0) / runResult.totalCount) * 100)
    : 0;
  const fileName = buildFileName(resource.title);

  async function runOnline(mode: 'run' | 'judge') {
    setRunningMode(mode);
    setRunError('');
    setRunResult(null);
    const response = await a3PostJson<CodeLabRunResponse>(`/api/resources/packs/${packId}/code-lab/run/`, {
      language: lab.language,
      code: stripMarkdownCodeFence(code),
      stdin,
      mode,
      testCases: mode === 'judge' ? lab.testCases : undefined,
    });
    setRunningMode('');
    if (!response.success || !response.result) {
      setRunError(response.error ?? '代码执行失败');
      return;
    }
    setRunResult(response.result);
  }

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(code);
      setCopyMessage('已复制当前代码');
    } catch {
      setCopyMessage('复制失败，请手动选择代码复制');
    }
    window.setTimeout(() => setCopyMessage(''), 1800);
  }

  function downloadCode() {
    const blob = new Blob([code], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function toggleCheckpoint(index: number) {
    setChecked((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  const main = (
    <div className="space-y-4" data-testid="a3-resource-code-lab-workbench">
      <section className="rounded-lg border border-blue-200 bg-blue-50 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-xs font-semibold text-blue-700">实验目标</div>
            <p className="mt-2 max-w-3xl text-sm leading-7 text-slate-800">{lab.objective}</p>
          </div>
          <div className="rounded-md border border-blue-200 bg-white px-3 py-2 text-xs text-blue-800">{lab.environment}</div>
        </div>
      </section>

      <section className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(320px,.85fr)]">
        <div className="min-w-0 overflow-hidden rounded-lg border border-slate-800 bg-slate-950">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 bg-slate-900 px-4 py-3">
            <div>
              <div className="text-sm font-semibold text-slate-100">代码编辑器</div>
              <div className="mt-1 font-mono text-xs text-slate-400">{fileName}</div>
            </div>
            <div className="flex flex-wrap gap-2">
              <IconButton
                label={editing ? '预览' : '编辑'}
                onClick={() => setEditing((value) => !value)}
                icon={editing ? <Code2 className="size-4" /> : <Pencil className="size-4" />}
              />
              <IconButton label="恢复" onClick={() => { setCode(lab.starterCode); }} icon={<RotateCcw className="size-4" />} />
              <IconButton label="复制" onClick={() => void copyCode()} icon={<Copy className="size-4" />} />
              <IconButton label="下载" onClick={downloadCode} icon={<Download className="size-4" />} />
            </div>
          </div>
          <CodeEditor code={code} editing={editing} onChange={setCode} onRequestEdit={() => setEditing(true)} />
        </div>

        <div className="min-w-0 overflow-hidden rounded-lg border border-slate-800 bg-slate-950">
          <div className="border-b border-slate-800 bg-slate-900 px-4 py-3">
            <div className="text-sm font-semibold text-slate-100">运行与判题</div>
            <div className="mt-1 text-xs text-slate-400">输出、错误和测试用例保持同时可见</div>
          </div>
          <div className="space-y-4 p-4">
            <div>
              <label htmlFor="a3-code-lab-stdin" className="text-xs font-semibold text-slate-300">标准输入 stdin</label>
              <textarea
                id="a3-code-lab-stdin"
                value={stdin}
                onChange={(event) => setStdin(event.target.value)}
                placeholder="没有 input() 时可以留空"
                className="mt-2 min-h-24 w-full resize-y rounded-md border border-slate-700 bg-slate-900 px-3 py-2 font-mono text-xs leading-5 text-slate-100 outline-none focus:border-blue-500"
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="button" disabled={Boolean(runningMode)} onClick={() => void runOnline('run')} className="bg-blue-600 text-white hover:bg-blue-700">
                {runningMode === 'run' ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
                运行代码
              </Button>
              <Button type="button" variant="outline" disabled={Boolean(runningMode) || !lab.testCases.length} onClick={() => void runOnline('judge')} className="border-slate-700 bg-slate-900 text-slate-100 hover:bg-slate-800">
                {runningMode === 'judge' ? <Loader2 className="size-4 animate-spin" /> : <CheckSquare2 className="size-4" />}
                提交判题
              </Button>
            </div>
            {!lab.testCases.length && <p className="text-xs leading-5 text-amber-300">当前资源没有测试用例，可以运行代码，但暂时不能判题。</p>}
            {runError && <div className="rounded-md border border-red-800 bg-red-950/50 p-3 text-sm text-red-200">{runError}</div>}
            {runResult ? <RunResultPanel result={runResult} /> : <EmptyTerminal expectedOutput={lab.expectedOutput} />}
          </div>
        </div>
      </section>
      {copyMessage && <p className="text-xs text-emerald-700">{copyMessage}</p>}
    </div>
  );

  const checkpoints = lab.checkpoints.map((label, index) => ({ label, completed: checked.has(index) }));
  const extra = (
    <>
      <RailSection title="调试提示">
        <TextList items={lab.hints} empty="先运行原始代码，再根据输出逐步修改。" />
      </RailSection>
      <RailSection title="常见失败">
        <TextList items={lab.commonFailures} empty="运行失败时先检查输入、缩进和返回值。" />
      </RailSection>
      <RailSection title="扩展挑战">
        <p className="text-sm leading-6 text-slate-600">{lab.extension}</p>
      </RailSection>
    </>
  );

  return (
    <ResourceWorkbenchShell
      main={main}
      rail={(
        <ResourceLearningRail
          resource={resource}
          progress={completion}
          progressLabel={`检查点 ${checked.size}/${lab.checkpoints.length}`}
          steps={lab.steps}
          checkpoints={checkpoints}
          onToggleCheckpoint={toggleCheckpoint}
          extra={extra}
          feedbackMessage={feedbackMessage}
          feedbackSaving={feedbackSaving}
          onFeedback={onFeedback}
          canComplete={canComplete}
          completionScore={completionScore}
          completionHint={lab.testCases.length ? '通过判题并完成全部检查点后，才能记录实验完成。' : '成功运行代码并完成全部检查点后，才能记录实验完成。'}
        />
      )}
    />
  );
}

function CodeEditor({
  code,
  editing,
  onChange,
  onRequestEdit,
}: {
  code: string;
  editing: boolean;
  onChange: (value: string) => void;
  onRequestEdit: () => void;
}) {
  const [highlighted, setHighlighted] = useState('');

  // Shiki 高亮是异步的，仅在预览态按当前代码渲染；编辑态直接用 textarea，避免逐字符高亮的抖动。
  useEffect(() => {
    if (editing) return;
    let active = true;
    highlightCode(code || '# 空代码', 'python')
      .then(([, dark]) => {
        if (active) setHighlighted(dark);
      })
      .catch(() => {
        if (active) setHighlighted('');
      });
    return () => {
      active = false;
    };
  }, [code, editing]);

  if (editing) {
    return (
      <textarea
        value={code}
        onChange={(event) => onChange(event.target.value)}
        spellCheck={false}
        aria-label="代码编辑器"
        className="min-h-[360px] w-full resize-y bg-slate-950 p-5 font-mono text-sm leading-6 text-slate-100 outline-none lg:min-h-[520px]"
      />
    );
  }

  if (highlighted) {
    return (
      <div
        role="button"
        tabIndex={0}
        onDoubleClick={onRequestEdit}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onRequestEdit();
          }
        }}
        title="双击进入编辑"
        aria-label="代码预览，双击进入编辑"
        className="min-h-[360px] w-full overflow-auto p-1 text-sm leading-6 lg:min-h-[520px] [&>pre]:m-0 [&>pre]:bg-transparent! [&>pre]:p-4 [&_code]:font-mono"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: Shiki 输出，代码来自本系统生成
        dangerouslySetInnerHTML={{ __html: highlighted }}
      />
    );
  }

  // 高亮尚未就绪时的降级：纯文本只读展示，保证内容始终可见。
  return (
    <pre className="min-h-[360px] w-full overflow-auto bg-slate-950 p-5 font-mono text-sm leading-6 text-slate-100 lg:min-h-[520px]">{code}</pre>
  );
}

function IconButton({ label, onClick, icon }: { label: string; onClick: () => void; icon: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} title={label} aria-label={label} className="flex size-8 items-center justify-center rounded-md border border-slate-700 text-slate-200 transition hover:bg-slate-800">
      {icon}
    </button>
  );
}

function EmptyTerminal({ expectedOutput }: { expectedOutput: string }) {
  return (
    <div className="rounded-md border border-slate-800 bg-slate-900 p-4">
      <div className="flex items-center gap-2 text-xs font-semibold text-slate-300"><TerminalSquare className="size-4" />等待运行</div>
      <p className="mt-2 text-xs leading-5 text-slate-400">预期：{expectedOutput}</p>
    </div>
  );
}

function RunResultPanel({ result }: { result: CodeLabRunResult }) {
  const passed = result.status === 'passed';
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3 rounded-md border border-slate-800 bg-slate-900 p-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
          {passed ? <CheckCircle2 className="size-4 text-emerald-400" /> : <XCircle className="size-4 text-red-400" />}
          {result.mode === 'judge' ? `通过 ${result.passedCount ?? 0}/${result.totalCount ?? 0}` : result.status}
        </div>
        <span className="text-xs text-slate-400">{result.durationMs ?? 0}ms</span>
      </div>
      {result.mode === 'judge' ? (
        <div className="space-y-2">
          {(result.testResults ?? []).map((item) => (
            <div key={item.name} className="rounded-md border border-slate-800 bg-slate-900 p-3">
              <div className="flex items-center justify-between gap-2 text-xs font-semibold text-slate-200">
                <span>{item.name}</span><span className={item.passed ? 'text-emerald-400' : 'text-red-400'}>{item.passed ? '通过' : item.status}</span>
              </div>
              {!item.passed && <pre className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-5 text-slate-400">期望：{item.expectedStdout}\n实际：{item.actualStdout}\n{item.stderr || item.error || ''}</pre>}
            </div>
          ))}
        </div>
      ) : (
        <div className="grid gap-3">
          <OutputBlock title="stdout" value={result.stdout || '(空输出)'} />
          {(result.stderr || result.error) && <OutputBlock title="stderr" value={result.stderr || result.error || ''} />}
        </div>
      )}
    </div>
  );
}

function OutputBlock({ title, value }: { title: string; value: string }) {
  return <div><div className="mb-1 text-xs font-semibold text-slate-400">{title}</div><pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-slate-900 p-3 font-mono text-xs leading-5 text-slate-100">{value}</pre></div>;
}

function TextList({ items, empty }: { items: string[]; empty: string }) {
  const values = items.length ? items : [empty];
  return <div className="space-y-2">{values.map((item) => <p key={item} className="text-sm leading-6 text-slate-600">{item}</p>)}</div>;
}

function buildFileName(title: string) {
  const slug = title.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 36) || 'code-lab';
  return `${slug}.py`;
}

function stripMarkdownCodeFence(code: string) {
  const lines = code.trim().split(/\r?\n/);
  if (lines[0]?.trim().startsWith('```')) lines.shift();
  if (lines[lines.length - 1]?.trim() === '```') lines.pop();
  return `${lines.join('\n').trim()}\n`;
}
