import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { prepareA3SpeechText } from '../lib/a3/speech-utils';

describe('A3 speech controls', () => {
  it('cleans markdown and latex into readable speech text', () => {
    const text = prepareA3SpeechText([
      '#### 步骤 3：阶跃响应',
      '',
      '$$ X(s)=G(s) \\cdot F(s)=\\frac{1}{s} $$',
      '',
      '| 维度 | 内容 |',
      '| --- | --- |',
      '| 定义 | 传递函数 |',
      '',
      '**结论**：系统稳定。',
    ].join('\n'));

    expect(text).toContain('步骤 3：阶跃响应');
    expect(text).toContain('X(s)=G(s) 乘以 F(s)= 分式 1 除以 s');
    expect(text).toContain('维度 内容');
    expect(text).toContain('结论：系统稳定。');
    expect(text).not.toContain('####');
    expect(text).not.toContain('$$');
    expect(text).not.toContain('\\frac');
    expect(text).not.toContain('| --- |');
  });

  it('wires classroom and coaching pages to per-reply speech and restart actions', () => {
    const classroom = fs.readFileSync(path.resolve(process.cwd(), 'components/a3/features/classroom-view.tsx'), 'utf8');
    const coaching = fs.readFileSync(path.resolve(process.cwd(), 'components/a3/features/coaching-view.tsx'), 'utf8');

    expect(classroom).toContain('A3SpeechControls');
    expect(classroom).toContain('data-testid="a3-classroom-new-dialogue"');
    expect(classroom).toContain('data-testid="a3-classroom-history-panel"');
    expect(coaching).toContain('A3SpeechControls');
    expect(coaching).toContain('data-testid="a3-coaching-new-dialogue"');
    expect(coaching).toContain('data-testid="a3-coaching-history-panel"');
  });
});
