import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const authPages = readFileSync(join(root, 'components/a3/auth/a3-auth-pages.tsx'), 'utf8');
const classroom = readFileSync(join(root, 'components/a3/features/classroom-view-redesign.tsx'), 'utf8');
const profileSetupStartMarker = 'export function ProfileSetupPage() {';
const profileSetupEndMarker = '\nfunction ProfileUpdateTimelinePanel({';
const profileSetupStart = authPages.indexOf(profileSetupStartMarker);
const profileSetupEnd = authPages.indexOf(profileSetupEndMarker, profileSetupStart);
const profileSetupSource = profileSetupStart >= 0 && profileSetupEnd > profileSetupStart
  ? authPages.slice(profileSetupStart, profileSetupEnd)
  : '';

describe('A3 real-user polish regressions', () => {
  it('keeps first-run copy focused on the learner instead of implementation details', () => {
    expect(authPages).toContain('完善几项学习设置');
    expect(authPages).toContain('开始设置');
    expect(authPages).not.toContain('这一步不会生成静态演示内容');
    expect(authPages).not.toContain('调用资料接口更新 onboardingStep');
    expect(authPages).not.toContain('下一步会写回你的首启进度');
    expect(authPages).not.toContain("title: 'Agent 追问'");
    expect(authPages).not.toContain("'画像访谈 Agent'");
    expect(authPages).not.toContain('保存后，PlannerAgent');
  });

  it('keeps profile setup guidance progressive and learner-facing', () => {
    expect(profileSetupStart).toBeGreaterThanOrEqual(0);
    expect(profileSetupEnd).toBeGreaterThan(profileSetupStart);
    expect(profileSetupSource).toContain('告诉我们你的学习情况');
    expect(profileSetupSource).toContain('不用一次说全');
    expect(profileSetupSource).toContain('系统会根据你的回答逐项追问');
    expect(profileSetupSource).toContain('发送并整理');
    expect(profileSetupSource).toContain('查看示例');
    expect(profileSetupSource).toContain('确认并开始入学诊断');
    expect(profileSetupSource).toContain('想自己修改？展开手动填写');
    expect(profileSetupSource).toContain("['学习节奏', profile.pace ? planModeLabel(profile.pace) : '']");

    expect(profileSetupSource).not.toContain('画像与规划输入');
    expect(profileSetupSource).not.toContain('先用一句话完成画像');
    expect(profileSetupSource).not.toContain('对话生成画像');
    expect(profileSetupSource).not.toContain('确认画像并生成诊断任务');
    expect(profileSetupSource).not.toContain('Agent 决策证据');
    expect(profileSetupSource).not.toContain('<InterviewInsightStrip');
    expect(profileSetupSource).not.toContain('<DynamicProfileInsightPanel');
    expect(profileSetupSource).not.toContain('逐项确认');
    expect(profileSetupSource).not.toContain('ProfileSetupWizard');
  });

  it('keeps profile setup loading, scrolling, and first-empty-state behavior explicit', () => {
    expect(profileSetupStart).toBeGreaterThanOrEqual(0);
    expect(profileSetupEnd).toBeGreaterThan(profileSetupStart);
    expect(profileSetupSource).toContain('const [loadingOptions, setLoadingOptions] = useState(true)');
    expect(profileSetupSource).not.toContain('setLoadingOptions(true)');
    expect(profileSetupSource).toContain('setLoadingOptions(false)');
    expect(profileSetupSource).toContain("loadingOptions ? '正在加载课程信息' : optionsCourse");
    expect(profileSetupSource).toContain('const interviewThreadRef = useRef<HTMLDivElement>(null)');
    expect(profileSetupSource).toContain('ref={interviewThreadRef}');
    expect(profileSetupSource).toContain("thread.scrollTo({ top: thread.scrollHeight, behavior: 'auto' })");
    expect(profileSetupSource).toContain('if (!hasHistory) return');
    expect(profileSetupSource).toContain('const showProfileSetupPanels =');
    expect(profileSetupSource).toContain('!showProfileSetupPanels');
    expect(profileSetupSource).toContain('系统会整理学习目标、基础、时间和偏好');
    expect(profileSetupSource).toContain('disabled={submitting || loadingOptions}');
  });

  it('uses adaptive theme surfaces in first-run flows and the AI classroom', () => {
    expect(authPages).toContain('showThemeToggle={false}');
    expect(authPages).toContain('[--a3-text:#0f172a]');
    expect(classroom).toContain('data-testid="a3-classroom-workspace"');
    expect(classroom).toContain('CLASSROOM_OUTLINE_BUTTON_CLASS');
    expect(classroom).toContain('dark:disabled:opacity-100');
  });
});
