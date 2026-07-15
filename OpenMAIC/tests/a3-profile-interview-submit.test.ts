import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const pagePath = path.resolve(process.cwd(), 'components/a3/auth/a3-auth-pages.tsx');

function sourceBetween(source: string, start: string, end: string) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

describe('A3 profile interview submit payload', () => {
  it('posts only the current interview input instead of replaying the full dialogue history', () => {
    const source = fs.readFileSync(pagePath, 'utf8');

    expect(source).toContain("const result = await a3PostJson<ProfileInterviewResult>('/api/profile/interview/', { message: messageText });");
    expect(source).not.toContain('{ message: dialogue }');
    expect(source).not.toContain("const dialogue = nextMessages.map");
  });

  it('posts the exact confirm action without client-side completion flags', () => {
    const source = fs.readFileSync(pagePath, 'utf8');

    expect(source).toContain("const result = await a3PostJson<ProfileInterviewResult>('/api/profile/interview/', { action: 'confirm' });");
    expect(source).not.toMatch(/interviewComplete:\s*true/);
    expect(source).not.toMatch(/profileCommitted:\s*true/);
    expect(source).not.toMatch(/generated:\s*\{\s*path:\s*true/);
  });

  it('keeps deferred planning metadata in both local interview contracts', () => {
    const source = fs.readFileSync(pagePath, 'utf8');
    const resultType = sourceBetween(source, 'type ProfileInterviewResult = {', '\ntype ProfileInterviewSession = {');
    const sessionType = sourceBetween(source, 'type ProfileInterviewSession = {', '\ntype ProfileInterviewAskStrategy = {');

    for (const contract of [resultType, sessionType]) {
      expect(contract).toContain('planningDeferred?: boolean;');
      expect(contract).toContain('planningDeferredReason?: string;');
    }
  });

  it('restores server-owned deferred and committed state without inferring completion', () => {
    const source = fs.readFileSync(pagePath, 'utf8');
    const restoreSource = sourceBetween(source, 'async function loadInterviewSession()', '\n  function toggle(');

    expect(restoreSource).toContain('profileCommitted: session.profileCommitted,');
    expect(restoreSource).toContain('planningDeferred: session.planningDeferred,');
    expect(restoreSource).toContain('planningDeferredReason: session.planningDeferredReason,');
    expect(restoreSource).toContain('interviewComplete: session.interviewComplete,');
    expect(restoreSource).not.toMatch(/interviewComplete:\s*(?:restoredMessages|missing|session\.turnCount)/);
  });

  it('treats a successful but uncommitted confirm response as incomplete', () => {
    const source = fs.readFileSync(pagePath, 'utf8');
    const confirmSource = sourceBetween(source, 'async function confirmProfileInterview()', '\n  async function resolveProfileUpdate(');

    expect(confirmSource).toContain('if (!result.success || !result.profileCommitted) {');
    expect(confirmSource).toContain('normalizeProfileInterviewMessages(result.interviewSession)');
    expect(confirmSource).toContain("setMessage(result.error ?? '还需要补充一项信息，请先回答上方问题。');");
    expect(confirmSource.indexOf('syncA3User(result.user)')).toBeGreaterThan(
      confirmSource.indexOf('if (!result.success || !result.profileCommitted) {'),
    );
  });

  it('uses diagnosis-first confirmation copy and preserves deferred planning evidence', () => {
    const source = fs.readFileSync(pagePath, 'utf8');
    const apiResultType = sourceBetween(source, 'type ApiResult = {', '\ntype ProfileInterviewResult = {');
    const confirmSource = sourceBetween(source, 'async function confirmProfileInterview()', '\n  async function resolveProfileUpdate(');

    expect(apiResultType).toContain('planningDeferred?: boolean;');
    expect(apiResultType).toContain('planningDeferredReason?: string;');
    expect(confirmSource).toContain("summary: '学习情况已保存，接下来通过几道题确认你的学习起点。',");
    expect(confirmSource).toContain('planningDeferred: result.planningDeferred,');
    expect(confirmSource).toContain('planningDeferredReason: result.planningDeferredReason,');
    expect(confirmSource).toContain("href: '/a3/admission-diagnostic'");
    expect(confirmSource).toContain('入学诊断会确认基础和薄弱点，并据此生成后续学习路径和计划。');
    expect(source).not.toContain('对话画像已确认，路径和学习计划已刷新。');
  });

  it('shows deferred planning as a diagnosis outcome instead of a generation failure', () => {
    const source = fs.readFileSync(pagePath, 'utf8');
    const previewSource = sourceBetween(source, 'function ProfilePlanningImpactPreview({', '\nfunction InterviewInsightStrip({');

    expect(source).toContain('学习路径和 14 天计划将在入学诊断后生成');
    expect(source).toContain('saveResult.planningDeferred ? (');
    expect(previewSource).toContain('saveResult?.planningDeferred ? (');
    expect(previewSource).toContain('完成入学诊断后，系统会据此生成学习路径和 14 天计划。');
  });

  it('uses concise interview retry and empty-answer guidance', () => {
    const source = fs.readFileSync(pagePath, 'utf8');
    const interviewSource = sourceBetween(source, 'async function runProfileInterview()', '\n  async function submit()');

    expect(interviewSource).toContain("setMessage('请先回答当前问题。');");
    expect(interviewSource).toContain("setMessage(result.error ?? '暂时无法整理这次回答，请稍后重试。');");
    expect(interviewSource).not.toContain('表单模式');
    expect(interviewSource).not.toContain('展开手动填写');
  });
});
