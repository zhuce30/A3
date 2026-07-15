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

  it('uses adaptive theme surfaces in first-run flows and the AI classroom', () => {
    expect(authPages).toContain('showThemeToggle={false}');
    expect(authPages).toContain('[--a3-text:#0f172a]');
    expect(classroom).toContain('data-testid="a3-classroom-workspace"');
    expect(classroom).toContain('CLASSROOM_OUTLINE_BUTTON_CLASS');
    expect(classroom).toContain('dark:disabled:opacity-100');
  });
});
