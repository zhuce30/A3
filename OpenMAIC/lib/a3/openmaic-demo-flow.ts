import type { A3OpenMAICPageOwnership } from './openmaic-page-ownership';

export type A3OpenMAICDemoFlowStep = {
  order: number;
  title: string;
  href: string;
  capability: string;
  evidence: string[];
  handoffRule: string;
  scriptLine: string;
};

const DEMO_ORDER = [
  '/a3/recommendations',
  '/a3/resources/[packId]',
  '/a3/classroom',
  '/a3/teacher',
  '/a3/capabilities',
  '/a3/knowledge-base',
];

export function buildOpenMAICDemoFlowSteps(items: A3OpenMAICPageOwnership[]): A3OpenMAICDemoFlowStep[] {
  const byPage = new Map(items.map((item) => [item.a3Page, item]));
  return DEMO_ORDER.map((page) => byPage.get(page))
    .filter((item): item is A3OpenMAICPageOwnership => Boolean(item))
    .map((item, index) => ({
      order: index + 1,
      title: `OpenMAIC ${item.pageName}`,
      href: item.a3Page.replace('[packId]', 'latest'),
      capability: item.primaryOpenMAICCapability,
      evidence: item.evidence,
      handoffRule: item.handoffRule,
      scriptLine: buildScriptLine(item),
    }));
}

function buildScriptLine(item: A3OpenMAICPageOwnership) {
  return `A3 页面 ${item.a3Page} 负责 ${item.responsibility}，通过 bridge/API 接入 OpenMAIC 能力，证据是 ${item.evidence
    .slice(0, 2)
    .join('、')}。`;
}
