import { describe, expect, it } from 'vitest';
import {
  clientPointToNormalizedRegionPoint,
  normalizeRegion,
  normalizedRegionToViewportRect,
  validateNormalizedRegion,
} from '@/lib/a3/realtime-media-focus';

describe('A3 realtime media geometry', () => {
  it('preserves validated automatic-region metadata', () => {
    expect(validateNormalizedRegion({
      x: 0.1,
      y: 0.2,
      width: 0.4,
      height: 0.5,
      label: '可能的文档区域',
      confidence: 0.83,
      method: 'document_proposal',
    })).toEqual({
      x: 0.1,
      y: 0.2,
      width: 0.4,
      height: 0.5,
      label: '可能的文档区域',
      confidence: 0.83,
      method: 'document_proposal',
    });
  });
  it('normalizes reverse drags and clamps them to source bounds', () => {
    expect(normalizeRegion({ x: 0.8, y: 0.9, width: -0.6, height: -1.2 })).toEqual({
      x: 0.2,
      y: 0,
      width: 0.6,
      height: 0.9,
    });
  });

  it('rejects regions that are too small', () => {
    expect(normalizeRegion({ x: 0.1, y: 0.1, width: 0.005, height: 0.005 })).toBeNull();
  });

  it('maps object-contain coordinates and rejects letterbox clicks', () => {
    const options = {
      sourceWidth: 1600,
      sourceHeight: 900,
      viewportWidth: 400,
      viewportHeight: 400,
      fit: 'contain' as const,
    };
    expect(clientPointToNormalizedRegionPoint({ x: 200, y: 20 }, options)).toBeNull();
    expect(clientPointToNormalizedRegionPoint({ x: 200, y: 200 }, options)).toEqual({ x: 0.5, y: 0.5 });
  });

  it('maps normalized source coordinates back to an object-cover viewport', () => {
    expect(normalizedRegionToViewportRect(
      { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
      {
        sourceWidth: 1600,
        sourceHeight: 900,
        viewportWidth: 400,
        viewportHeight: 400,
        fit: 'cover',
      },
    )).toEqual({ x: 22.22222222222223, y: 100, width: 355.55555555555554, height: 200 });
  });

  it('strictly validates region metadata received by the frame route', () => {
    expect(validateNormalizedRegion({ x: 0.1, y: 0.2, width: 0.4, height: 0.5 })).toEqual({
      x: 0.1,
      y: 0.2,
      width: 0.4,
      height: 0.5,
    });
    expect(validateNormalizedRegion({ x: -0.1, y: 0, width: 0.5, height: 0.5 })).toBeNull();
    expect(validateNormalizedRegion({ x: 0.8, y: 0, width: 0.5, height: 0.5 })).toBeNull();
    expect(validateNormalizedRegion({ x: 0, y: 0, width: Number.NaN, height: 0.5 })).toBeNull();
    expect(validateNormalizedRegion({ x: 0, y: 0, width: 0.5, height: 0.5, label: 'x'.repeat(81) })).toBeNull();
  });
});
