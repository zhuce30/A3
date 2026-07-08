import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const sourcePath = path.resolve(process.cwd(), 'components/a3/features/recommendations-view.tsx');

describe('A3 recommendations page quality', () => {
  it('does not render internal tone enum values as learner-facing labels', () => {
    const source = fs.readFileSync(sourcePath, 'utf8');

    expect(source).not.toContain('{signal.tone}</A3Pill>');
    expect(source).not.toMatch(/>\s*(blue|green|violet|orange|slate)\s*<\/A3Pill>/);
    expect(source).toContain('profileSignalToneLabel(signal.tone)');
  });

  it('keeps the resource pack connected to the A3 classroom page', () => {
    const source = fs.readFileSync(sourcePath, 'utf8');

    expect(source).toContain("href=\"/a3/classroom\"");
    expect(source).toContain("'/api/resources/packs/'");
    expect(source).toContain("'/api/a3/resources/openmaic-classroom'");
  });

  it('stacks the recommendation header and evidence to avoid an empty middle panel', () => {
    const source = fs.readFileSync(sourcePath, 'utf8');

    expect(source).toContain('<section className="grid gap-4">');
    expect(source).not.toContain('grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_420px]');
  });

  it('collapses long recommendation lists with aligned expand controls', () => {
    const source = fs.readFileSync(sourcePath, 'utf8');

    expect(source).toContain('recommendationsExpanded');
    expect(source).toContain('visibleRecommendations');
    expect(source).toContain('recommendations.slice(0, 3)');
    expect(source).toContain('data-testid="a3-recommendation-list-toggle"');
    expect(source).toContain('data-testid="a3-recommendation-list-inline-toggle"');
    expect(source).toContain('action={');
    expect(source).toContain('className="flex items-center gap-2"');
    expect(source).not.toContain('className="flex justify-end"');
  });

  it('explains recommendation ordering as a learner action, not an abstract sort', () => {
    const source = fs.readFileSync(sourcePath, 'utf8');

    expect(source).toContain('按目标重新推荐');
    expect(source).toContain('补充知识库证据');
    expect(source).toContain('data-testid="a3-recommendation-user-benefit"');
    expect(source).toContain('data-testid="a3-recommendation-sort-benefit-strip"');
    expect(source).toContain('这次排序给你的直接帮助');
    expect(source).not.toContain('重新排序');
  });

  it('uses clear learner actions instead of a generic open link on recommendation cards', () => {
    const source = fs.readFileSync(sourcePath, 'utf8');

    expect(source).toContain('今日优先学习动作');
    expect(source).toContain('buildRecommendationAction');
    expect(source).toContain('进课堂学习');
    expect(source).toContain('查看来源资料');
    expect(source).not.toContain('<Link href={item.href}>打开');
    expect(source).not.toContain('label="画像"');
    expect(source).not.toContain('label="排序"');
    expect(source).not.toContain("sourceEvidence ? '证据' : '降级'");
  });

  it('does not keep the retired evidence component or mojibake text in the page source', () => {
    const source = fs.readFileSync(sourcePath, 'utf8');
    const mojibakeTokens = ['锛', '绛', '鎺', '鐢', '璧', '鏉', '鈥', '€', '�'];

    expect(source).not.toContain('_RecommendationEvidenceCard');
    for (const token of mojibakeTokens) {
      expect(source).not.toContain(token);
    }
  });

  it('positions recommendations as a resource generation workspace', () => {
    const source = fs.readFileSync(sourcePath, 'utf8');

    expect(source).toContain('资源生成工作台');
    expect(source).toContain('data-testid="a3-resource-generation-primary"');
    expect(source).toContain('讲义文档');
    expect(source).toContain('思维导图');
    expect(source).toContain('视频脚本');
    expect(source).toContain('代码实验');
    expect(source).toContain('生成课堂/PPT');
    expect(source).toContain('生成视频任务');
  });

  it('keeps resource pack generation as a single primary action', () => {
    const source = fs.readFileSync(sourcePath, 'utf8');

    expect(source).toContain('data-testid="a3-resource-generation-primary"');
    expect(source).toContain('生成完整资源包');
    expect(source).not.toContain('data-testid="a3-resource-pack-v2-generate"');
    expect(source).not.toContain('onGenerate={generateResourcePackV2}');
  });

  it('lets learners generate an individual resource type from the resource workspace', () => {
    const source = fs.readFileSync(sourcePath, 'utf8');

    expect(source).toContain('generateSingleResourceV2');
    expect(source).toContain("onClick={() => void generateSingleResourceV2(item.type)}");
    expect(source).toContain('resourceType,');
    expect(source).toContain('data-testid="a3-single-resource-generate"');
    expect(source).toContain('单独生成');
    expect(source).toContain('data-testid="a3-classroom-ppt-generate"');
  });

  it('shows the generation evidence before learners choose a generation action', () => {
    const source = fs.readFileSync(sourcePath, 'utf8');

    expect(source).toContain('data-testid="a3-resource-generation-evidence"');
    expect(source).toContain('当前课程');
    expect(source).toContain('当前路径节点');
    expect(source).toContain('知识库来源');
    expect(source).toContain('RetrieverAgent');
    expect(source).toContain('ResourceSynthesisAgent');
    expect(source).toContain('VerifierAgent');
  });

  it('separates full pack generation from single resource generation', () => {
    const source = fs.readFileSync(sourcePath, 'utf8');

    expect(source).toContain('data-testid="a3-full-resource-pack-generate"');
    expect(source).toContain('生成完整资源包');
    expect(source).toContain('data-testid="a3-single-resource-type-grid"');
    expect(source).toContain('按需单项生成');
  });

  it('groups generated pack results into overview, preview, evidence, and next actions', () => {
    const source = fs.readFileSync(sourcePath, 'utf8');

    expect(source).toContain('data-testid="a3-resource-result-overview"');
    expect(source).toContain('data-testid="a3-resource-result-preview"');
    expect(source).toContain('data-testid="a3-resource-result-evidence"');
    expect(source).toContain('data-testid="a3-resource-result-next-actions"');
  });

  it('provides a stable entry to the latest generated resource pack', () => {
    const source = fs.readFileSync(sourcePath, 'utf8');

    expect(source).toContain('data-testid="a3-open-latest-resource-pack"');
    expect(source).toContain('href="/a3/resources/latest"');
    expect(source).toContain('查看最新资源包');
  });

  it('sanitizes mojibake returned by recommendation APIs before rendering', () => {
    const source = fs.readFileSync(sourcePath, 'utf8');

    expect(source).toContain('sanitizeRecommendationResponse');
    expect(source).toContain('sanitizeResourcePackV2');
    expect(source).toContain('sanitizeA3Text');
    expect(source).toContain('hasMojibake');
  });

  it('does not use duplicate-prone recommendation weight labels as React keys', () => {
    const source = fs.readFileSync(sourcePath, 'utf8');

    expect(source).not.toContain('key={weight.label}');
    expect(source).toContain('key={`${weight.label}-${index}`}');
  });
});
