import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { A3Markdown } from '../components/a3/ui/a3-markdown';

describe('A3Markdown', () => {
  it('normalizes completion marks inside math without emitting KaTeX font warnings', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const html = renderToStaticMarkup(
      createElement(A3Markdown, null, '$$\\text{✅ 已完成}\\quad \\text{✓ 已掌握}$$'),
    );

    expect(html).toContain('katex');
    expect(html).toContain('checkmark');
    expect(html).not.toContain('$$\\text');
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('No character metrics'));
    warn.mockRestore();
  });

  it('renders display math as KaTeX instead of exposing raw delimiters', () => {
    const html = renderToStaticMarkup(
      createElement(A3Markdown, null, '公式如下：\n\n$$G_c(s)=K_p+\\frac{K_i}{s}+K_d s$$'),
    );

    expect(html).toContain('katex');
    expect(html).toContain('G');
    expect(html).not.toContain('$$G_c');
  });

  it('renders backslash math delimiters commonly returned by LLMs', () => {
    const html = renderToStaticMarkup(
      createElement(A3Markdown, null, 'Inline \\(E=mc^2\\)\n\n\\[G(s)=\\frac{1}{s+1}\\]'),
    );

    expect(html).toContain('katex');
    expect(html).not.toContain('\\(E=mc^2\\)');
    expect(html).not.toContain('\\[G(s)');
  });

  it('renders basic markdown structure for tutoring answers', () => {
    const html = renderToStaticMarkup(
      createElement(A3Markdown, null, '### 讲解\n\n- 先看概念\n- 再做练习\n\n**结论**：需要引用验证。'),
    );

    expect(html).toContain('<h3');
    expect(html).toContain('<li');
    expect(html).toContain('<strong');
  });

  it('renders standard markdown tables as three-line teaching tables', () => {
    const html = renderToStaticMarkup(
      createElement(
        A3Markdown,
        null,
        [
          '### 考查点说明',
          '',
          '| 考查维度 | 具体内容 | 对应能力 |',
          '| --- | --- | --- |',
          '| 定义理解 | 是否能说明传递函数 | 概念辨识 |',
          '| 数学推导 | 是否能写出拉氏变换步骤 | 公式推导 |',
        ].join('\n'),
      ),
    );

    expect(html).toContain('<table');
    expect(html).toContain('a3-three-line-table');
    expect(html).toContain('<thead');
    expect(html).toContain('<tbody');
    expect(html).toContain('<th');
    expect(html).toContain('<td');
    expect(html).toContain('考查维度');
    expect(html).not.toContain('| --- | --- | --- |');
  });

  it('repairs compact pipe tables returned inside citation claim text', () => {
    const compact = '::: ### Evidence table | Dimension | Content | Ability | | --- | --- | --- | | Definition | Transfer function relation | Conceptual understanding |';
    const html = renderToStaticMarkup(createElement(A3Markdown, null, compact));

    expect(html).toContain('<table');
    expect(html).toContain('<th');
    expect(html).toContain('<td');
    expect(html).toContain('Dimension');
    expect(html).not.toContain('| --- | --- | --- |');
  });

  it('renders h4 step headings and common unwrapped latex fragments', () => {
    const html = renderToStaticMarkup(
      createElement(
        A3Markdown,
        null,
        [
          '#### 步骤 3：阶跃响应',
          '',
          '- c = 4 N\\cdotp s/m（粘性阻尼系数）',
          '',
          '$$ X(s) = G(s) \\cdot F(s) = \\frac{1}{2s^2 + 4s + 6} \\cdot \\frac{1}{s} $$',
        ].join('\n'),
      ),
    );

    expect(html).toContain('<h4');
    expect(html).toContain('katex');
    expect(html).not.toContain('<p>#### 步骤');
    expect(html).not.toContain('<li>c = 4 N\\cdotp');
  });

  it('repairs single-line display math with a missing closing delimiter', () => {
    const html = renderToStaticMarkup(
      createElement(A3Markdown, null, '$$ X(s) = G(s) \\cdot F(s) = \\frac{1}{2s^2 + 4s + 6} \\cdot \\frac{1}{s} ='),
    );

    expect(html).toContain('katex-display');
    expect(html).not.toContain('<p>$$ X(s)');
  });

  it('repairs mixed inline dollar and latex command equation lines into display math', () => {
    const html = renderToStaticMarkup(
      createElement(A3Markdown, null, '$1 + G(s)H(s) = 0$\\quad \\Leftrightarrow \\quad 1 + \\frac{K N(s)}{D(s)} = 0.'),
    );

    expect(html).toContain('katex-display');
    expect(html).toContain('Leftrightarrow');
    expect(html).not.toContain('$1 + G(s)H(s)');
    expect(html).not.toContain('katex-error');
  });

  it('renders bare PPT equations as KaTeX inline math', () => {
    const html = renderToStaticMarkup(
      createElement(A3Markdown, null, '系统的闭环特征方程为： s² + 2s + Kg = 0，求解闭环特征根。'),
    );

    expect(html).toContain('katex');
    expect(html).toContain('闭环特征方程');
  });

  it('repairs PPT Symbol font private-use characters before rendering', () => {
    const html = renderToStaticMarkup(
      createElement(A3Markdown, null, '参数从0\uf0ae\uf0a5；s2从（\uf02d2,j0）开始；用\uf0b4表示；\uf0e5\uf06aj - \uf0e5\uf071i = (2k+1)\uf070；60\uf0b0'),
    );

    expect(html).not.toMatch(/[\ue000-\uf8ff]/);
    expect(html).toContain('0→∞');
    expect(html).toContain('（-2,j0）');
    expect(html).toContain('×');
    expect(html).toContain('Σφj - Σθi = (2k+1)π');
    expect(html).toContain('60°');
  });

  it('does not split root assignment text into broken inline math', () => {
    const html = renderToStaticMarkup(
      createElement(
        A3Markdown,
        null,
        '求得闭环特征根为： 系统的闭环特征方程为： s2 + 2s + Kg = 0 求得闭环特征根为： (1) Kg= 0：s1 = 0,s2 = \uf02d2,是根迹的起点(开环极点),用“\uf0b4”表示。',
      ),
    );

    expect(html).toContain('katex');
    expect(html).not.toMatch(/\$s1 = 0,s2\$= -2/);
    expect(html).not.toMatch(/\$s2\s*\$/);
    expect(html).not.toMatch(/[\ue000-\uf8ff]/);
    expect(html).toContain('s1 = 0,s2 = -2');
    expect(html).toContain('×');
  });

  it('infers markdown tables from compact PPT pipe text without a separator row', () => {
    const compact = '| 评价阶段 | 评价项目 | 权重 | 平时成绩 | 自主学习 | 20% | 课堂测验 | 知识掌握 | 20% |';
    const html = renderToStaticMarkup(createElement(A3Markdown, null, compact));

    expect(html).toContain('<table');
    expect(html).toContain('<thead');
    expect(html).toContain('<tbody');
    expect(html).toContain('评价阶段');
    expect(html).not.toContain('| 评价阶段 |');
  });

  it('repairs assistant answers that mix horizontal rules, headings, formulas and tables on one line', () => {
    const broken = [
      '--- ### 二、绘制根轨迹的四条基本法则（精简可执行版） 根据资料整理如下： | 法则 | 内容 | 应用示例（以 $G(s)H(s)=\\frac{K}{s(s+2)}$ 为例） | |-----|------|--------------------------------------------|',
      '| 起点与终点 | 起于开环极点，终于开环零点或无穷远 | 开环极点：s=0, s=-2 |',
      '',
      '⇔ $ G(s)H(s) = -1 $',
      '',
      '| **实轴上的根轨迹** | 实轴上某段右侧的开环实极点与实零点总数为奇数，则该段属于根轨迹 | 实轴区间 $[-2,0]$ 有效 |',
    ].join('\n');
    const html = renderToStaticMarkup(createElement(A3Markdown, null, broken));

    expect(html).toContain('<h3');
    expect(html).toContain('二、绘制根轨迹的四条基本法则');
    expect(html).toContain('<table');
    expect(html).toContain('a3-three-line-table');
    expect(html).toContain('katex');
    expect(html).not.toContain('--- ###');
    expect(html).not.toContain('|-----|');
    expect(html).not.toContain('$ G(s)H(s) = -1 $');
  });

  it('cleans quoted dirty markdown and html breaks from tutoring answers', () => {
    const broken = [
      '> - 因此，**频域中“是否包围 $-1$ 点”** 对应时域稳定性。',
      '> s = j\\omega \\quad \\text{代入}\\quad 1 + G(s)H(s) = 0 <br>• 特征根位置',
      '> --- ### 下一步练习建议',
    ].join('\n');
    const html = renderToStaticMarkup(createElement(A3Markdown, null, broken));

    expect(html).toContain('频域中');
    expect(html).toContain('katex');
    expect(html).toContain('<h3');
    expect(html).not.toContain('&gt;');
    expect(html).not.toContain('<br');
    expect(html).not.toContain('--- ###');
  });

  it('repairs prose wrapped in display-math delimiters without breaking inline formulas', () => {
    const broken = [
      '$$因此，**频域中“是否包围 $-1$ 点” ↔ 时域中特征根是否位于左半平面**。 🔑 关键桥梁： $$',
      '',
      '$$这就是频域稳定性判据（[1] 中 5.4 节）的数学根源。 ### 一个可执行的小例子',
      '',
      '考虑惯性环节： $$',
      '',
      '$$3. **稳定性观察**：开环无右极点（$P=0$）；不包围 $(-1,j0)$，故 $Z=0$。',
    ].join('\n');
    const html = renderToStaticMarkup(createElement(A3Markdown, null, broken));

    expect(html).toContain('频域中');
    expect(html).toContain('关键桥梁');
    expect(html).toContain('<h3');
    expect(html).toContain('一个可执行的小例子');
    expect(html).toContain('katex');
    expect(html).not.toContain('$$因此');
    expect(html).not.toContain('关键桥梁： $$');
    expect(html).not.toContain('考虑惯性环节： $$');
    expect(html).not.toContain('$$3.');
  });

  it('repairs compact tables whose rows are glued together with double pipes', () => {
    const broken = [
      '### 下一步练习建议（紧扣学习目标） | 练习目标 | 具体任务 | 所需资料支持 ||----------|----------|-------------- || 建立直观联系 | 对比同一系统的频域法与根轨迹法 | [1] 中 5.2、5.4 |',
      '| 动手验证 | 手绘 $G(s)=\\frac{K}{s(s+1)}$ 的伯德图 | [1] 中 5.3、5.5 |',
    ].join('\n');
    const html = renderToStaticMarkup(createElement(A3Markdown, null, broken));

    expect(html).toContain('<h3');
    expect(html).toContain('<table');
    expect(html).toContain('练习目标');
    expect(html).toContain('建立直观联系');
    expect(html).toContain('katex');
    expect(html).not.toContain('||----------');
    expect(html).not.toContain('| 练习目标 |');
  });
});
