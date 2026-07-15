import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const pagePath = path.resolve(process.cwd(), 'components/a3/auth/a3-auth-pages.tsx');
const source = fs.readFileSync(pagePath, 'utf8');

function sourceBetween(source: string, start: string, end: string) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

describe('A3 profile interview submit payload', () => {
  it('posts only the current interview input instead of replaying the full dialogue history', () => {
    const interviewSource = sourceBetween(source, 'async function runProfileInterview()', '\n  async function submit()');

    expect(interviewSource).toContain("const result = await a3PostJson<ProfileInterviewResult>('/api/profile/interview/', { message: messageText });");
    expect(interviewSource).not.toContain('{ message: dialogue }');
  });

  it('posts the exact confirm action without client-side completion flags', () => {
    const confirmSource = sourceBetween(source, 'async function confirmProfileInterview()', '\n  async function resolveProfileUpdate(');

    expect(confirmSource).toContain("const result = await a3PostJson<ProfileInterviewResult>('/api/profile/interview/', { action: 'confirm' });");
    expect(confirmSource).not.toMatch(/interviewComplete:\s*true/);
    expect(confirmSource).not.toMatch(/profileCommitted:\s*true/);
    expect(confirmSource).not.toMatch(/generated:\s*\{\s*path:\s*true/);
  });

  it('keeps deferred planning metadata in both local interview contracts', () => {
    const resultType = sourceBetween(source, 'type ProfileInterviewResult = {', '\ntype ProfileInterviewSession = {');
    const sessionType = sourceBetween(source, 'type ProfileInterviewSession = {', '\ntype ProfileInterviewAskStrategy = {');

    for (const contract of [resultType, sessionType]) {
      expect(contract).toContain('planningDeferred?: boolean;');
      expect(contract).toContain('planningDeferredReason?: string;');
    }
  });

  it('restores server-owned deferred and committed state without inferring completion', () => {
    const restoreSource = sourceBetween(source, 'async function loadInterviewSession()', '\n  function toggle(');

    expect(restoreSource).toContain('profileCommitted: session.profileCommitted,');
    expect(restoreSource).toContain('planningDeferred: session.planningDeferred,');
    expect(restoreSource).toContain('planningDeferredReason: session.planningDeferredReason,');
    expect(restoreSource).toContain('interviewComplete: session.interviewComplete,');
    expect(restoreSource).not.toMatch(/interviewComplete:\s*(?:restoredMessages|missing|session\.turnCount)/);
  });

  it('treats a successful but uncommitted confirm response as incomplete', () => {
    const confirmSource = sourceBetween(source, 'async function confirmProfileInterview()', '\n  async function resolveProfileUpdate(');

    expect(confirmSource).toContain('if (!result.success || !result.profileCommitted) {');
    expect(confirmSource.match(/transitionProfileInterviewUiState\(/g) ?? []).toHaveLength(1);
    expect(confirmSource).toContain('setInterviewResult(transition.result)');
    expect(confirmSource).toContain('setMissingInterviewDimensions(transition.missingDimensions)');
    expect(confirmSource).toContain('setInterviewMessages(transition.messages)');
    expect(confirmSource).toContain('normalizeProfileInterviewMessages(result.interviewSession)');
    expect(confirmSource).toContain("setMessage(result.error ?? '还需要补充一项信息，请先回答上方问题。');");
    expect(confirmSource.indexOf('syncA3User(result.user)')).toBeGreaterThan(
      confirmSource.indexOf('if (!result.success || !result.profileCommitted) {'),
    );
  });

  it('uses diagnosis-first confirmation copy and preserves deferred planning evidence', () => {
    const apiResultType = sourceBetween(source, 'type ApiResult = {', '\ntype ProfileInterviewResult = {');
    const confirmSource = sourceBetween(source, 'async function confirmProfileInterview()', '\n  async function resolveProfileUpdate(');

    expect(apiResultType).toContain('planningDeferred?: boolean;');
    expect(apiResultType).toContain('planningDeferredReason?: string;');
    expect(confirmSource).toContain("summary: '学习情况已保存，接下来通过几道题确认你的学习起点。',");
    expect(confirmSource).toContain('planningDeferred: result.planningDeferred,');
    expect(confirmSource).toContain('planningDeferredReason: result.planningDeferredReason,');
    expect(confirmSource).toContain("href: '/a3/admission-diagnostic'");
    expect(confirmSource).toContain('入学诊断会确认基础和薄弱点，并据此生成后续学习路径和计划。');
    expect(confirmSource).not.toContain('对话画像已确认，路径和学习计划已刷新。');
  });

  it('shows deferred planning as a diagnosis outcome instead of a generation failure', () => {
    const profileSetupSource = sourceBetween(source, 'export function ProfileSetupPage() {', '\nfunction ProfileUpdateTimelinePanel({');
    const previewSource = sourceBetween(source, 'function ProfilePlanningImpactPreview({', '\nfunction InterviewInsightStrip({');

    expect(profileSetupSource).toContain('学习路径和 14 天计划将在入学诊断后生成。');
    expect(profileSetupSource).toContain('saveResult.planningDeferred ? (');
    expect(previewSource).toContain('saveResult?.planningDeferred ? (');
    expect(previewSource).toContain('完成入学诊断后，系统会据此生成学习路径和 14 天计划。');
    expect(profileSetupSource).not.toMatch(/\{[^{}\n]*planningDeferredReason[^{}\n]*\}/);
    expect(profileSetupSource).not.toContain('awaiting_admission_diagnostic');
  });

  it('uses concise interview retry and empty-answer guidance', () => {
    const interviewSource = sourceBetween(source, 'async function runProfileInterview()', '\n  async function submit()');
    const profileSetupSource = sourceBetween(source, 'export function ProfileSetupPage() {', '\nfunction ProfileUpdateTimelinePanel({');

    expect(interviewSource).toContain('if (submitting || interviewLoading || loadingOptions) return;');
    expect(interviewSource).toContain("setMessage('请先回答当前问题。');");
    expect(interviewSource).toContain("setMessage(result.error ?? '暂时无法整理这次回答，请稍后重试。');");
    expect(profileSetupSource).toContain('disabled={interviewLoading || submitting || loadingOptions}');
    expect(interviewSource).not.toContain('表单模式');
    expect(interviewSource).not.toContain('展开手动填写');
  });
});
