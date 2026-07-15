import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const authPages = readFileSync(join(root, 'components/a3/auth/a3-auth-pages.tsx'), 'utf8');
const classroom = readFileSync(join(root, 'components/a3/features/classroom-view-redesign.tsx'), 'utf8');

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
    expect(authPages).toContain('告诉我们你的学习情况');
    expect(authPages).toContain('不用一次说全');
    expect(authPages).toContain('系统会根据你的回答逐项追问');
    expect(authPages).toContain('发送并整理');
    expect(authPages).toContain('查看示例');
    expect(authPages).toContain('确认并开始入学诊断');
    expect(authPages).toContain('想自己修改？展开手动填写');

    expect(authPages).not.toContain('画像与规划输入');
    expect(authPages).not.toContain('先用一句话完成画像');
    expect(authPages).not.toContain('对话生成画像');
    expect(authPages).not.toContain('确认画像并生成诊断任务');
    expect(authPages).not.toContain('Agent 决策证据');
    expect(authPages).not.toContain('逐项确认');
    expect(authPages).not.toContain('ProfileSetupWizard');
  });

  it('uses adaptive theme surfaces in first-run flows and the AI classroom', () => {
    expect(authPages).toContain('showThemeToggle={false}');
    expect(authPages).toContain('[--a3-text:#0f172a]');
    expect(classroom).toContain('data-testid="a3-classroom-workspace"');
    expect(classroom).toContain('CLASSROOM_OUTLINE_BUTTON_CLASS');
    expect(classroom).toContain('dark:disabled:opacity-100');
  });
});
