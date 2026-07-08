import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const view = readFileSync(join(root, 'components/a3/features/dashboard-view.tsx'), 'utf8');

describe('A3 dashboard real data and humane copy', () => {
  it('keeps dashboard data wired to real backend endpoints', () => {
    expect(view).toContain("'/api/learning/dashboard/'");
    expect(view).toContain("'/api/assessments/report/'");
    expect(view).toContain("'/api/learning/classroom/'");
    expect(view).toContain("'/api/learning/study-plan/?auto=1'");
    expect(view).toContain("'/api/profiles/me/'");
  });

  it('explains real data sources and assistant boundaries', () => {
    expect(view).toContain('数据来自学习路径、计划、测评、课堂和画像接口');
    expect(view).toContain('全部来自后端报告和学习路径，不使用前端假数。');
    expect(view).toContain('这里是辅导入口。真正对话会进入面对面辅导页');
    expect(view).toContain('徽章只由任务、复盘和计划进度触发，不做前端假点亮。');
  });

  it('does not contain common mojibake fragments in visible dashboard copy', () => {
    expect(view).not.toMatch(/[鐭鍥璺璇鎺钖瀛浠鏃鍔绔]/);
  });
});
