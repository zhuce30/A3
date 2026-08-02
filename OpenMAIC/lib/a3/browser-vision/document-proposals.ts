import { normalizeRegion } from '../realtime-media-focus';
import type { BrowserDetectionCandidate } from './detector-types';

export type DocumentContourCandidate = {
  x: number;
  y: number;
  width: number;
  height: number;
  area: number;
  convex: boolean;
  vertices: number;
};

export function buildDocumentProposals(
  contours: DocumentContourCandidate[],
  frame: { width: number; height: number; source?: 'camera' | 'screen' },
): BrowserDetectionCandidate[] {
  if (frame.width <= 0 || frame.height <= 0) return [];
  const frameArea = frame.width * frame.height;
  const isScreen = frame.source === 'screen';
  return contours
    .filter((candidate) => candidate.convex && (
      candidate.vertices === 4
      || (isScreen && candidate.vertices >= 4 && candidate.vertices <= 6)
    ))
    .filter((candidate) => candidate.area / frameArea >= (isScreen ? 0.03 : 0.05) && candidate.area / frameArea <= (isScreen ? 0.96 : 0.92))
    .filter((candidate) => candidate.width / candidate.height >= (isScreen ? 0.35 : 0.45) && candidate.width / candidate.height <= (isScreen ? 3 : 2.2))
    .filter((candidate) => !isScreen || candidate.area / Math.max(1, candidate.width * candidate.height) >= 0.68)
    .sort((left, right) => right.area - left.area)
    .flatMap((candidate, index): BrowserDetectionCandidate[] => {
      const rectangularity = Math.min(1, candidate.area / Math.max(1, candidate.width * candidate.height));
      const confidence = Math.round((0.55 + rectangularity * 0.35) * 10_000) / 10_000;
      const region = normalizeRegion({
        x: candidate.x / frame.width,
        y: candidate.y / frame.height,
        width: candidate.width / frame.width,
        height: candidate.height / frame.height,
        label: '可能的文档区域',
        confidence,
        method: 'document_proposal',
      });
      if (!region) return [];
      return [{
        id: `document-${index}`,
        category: 'document',
        label: '可能的文档区域',
        confidence,
        method: 'document_proposal',
        region,
      }];
    })
    .slice(0, 2);
}
