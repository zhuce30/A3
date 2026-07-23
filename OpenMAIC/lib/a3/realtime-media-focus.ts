export type RealtimeFocusedMedia = 'camera' | 'screen' | null;

export type NormalizedMediaRegion = {
  x: number;
  y: number;
  width: number;
  height: number;
  label?: string;
  confidence?: number;
  method?: 'object_detection' | 'document_proposal' | 'manual' | 'full_frame';
};

export type MediaFitGeometry = {
  sourceWidth: number;
  sourceHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  fit: 'cover' | 'contain';
  mirrored?: boolean;
};

export type MediaPoint = { x: number; y: number };
export type MediaRect = { x: number; y: number; width: number; height: number };

const MIN_REGION_EDGE = 0.01;
const precision = (value: number) => Math.round(value * 1_000_000) / 1_000_000;
const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

export function normalizeRegion(
  region: NormalizedMediaRegion,
  minimumEdge = MIN_REGION_EDGE,
): NormalizedMediaRegion | null {
  if (![region.x, region.y, region.width, region.height].every(Number.isFinite)) return null;
  const left = clamp01(Math.min(region.x, region.x + region.width));
  const right = clamp01(Math.max(region.x, region.x + region.width));
  const top = clamp01(Math.min(region.y, region.y + region.height));
  const bottom = clamp01(Math.max(region.y, region.y + region.height));
  const width = precision(right - left);
  const height = precision(bottom - top);
  if (width < minimumEdge || height < minimumEdge) return null;
  return {
    x: precision(left),
    y: precision(top),
    width,
    height,
    ...(region.label ? { label: region.label.trim().slice(0, 80) } : {}),
    ...(typeof region.confidence === 'number' && Number.isFinite(region.confidence)
      ? { confidence: precision(clamp01(region.confidence)) }
      : {}),
    ...(region.method ? { method: region.method } : {}),
  };
}

export function validateNormalizedRegion(value: unknown): NormalizedMediaRegion | null {
  if (!value || typeof value !== 'object') return null;
  const region = value as Partial<NormalizedMediaRegion>;
  const values = [region.x, region.y, region.width, region.height];
  if (!values.every((item) => typeof item === 'number' && Number.isFinite(item))) return null;
  const x = region.x as number;
  const y = region.y as number;
  const width = region.width as number;
  const height = region.height as number;
  if (x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > 1 || y + height > 1) return null;
  if (width < MIN_REGION_EDGE || height < MIN_REGION_EDGE) return null;
  if (region.label !== undefined && (typeof region.label !== 'string' || region.label.length > 80)) return null;
  if (region.confidence !== undefined && (
    typeof region.confidence !== 'number'
    || !Number.isFinite(region.confidence)
    || region.confidence < 0
    || region.confidence > 1
  )) return null;
  if (region.method !== undefined && !['object_detection', 'document_proposal', 'manual', 'full_frame'].includes(region.method)) return null;
  return {
    x: precision(x),
    y: precision(y),
    width: precision(width),
    height: precision(height),
    ...(region.label?.trim() ? { label: region.label.trim() } : {}),
    ...(region.confidence !== undefined ? { confidence: precision(region.confidence) } : {}),
    ...(region.method ? { method: region.method } : {}),
  };
}

function resolveFit(geometry: MediaFitGeometry) {
  const {
    sourceWidth,
    sourceHeight,
    viewportWidth,
    viewportHeight,
    fit,
  } = geometry;
  if (![sourceWidth, sourceHeight, viewportWidth, viewportHeight].every((value) => Number.isFinite(value) && value > 0)) {
    return null;
  }
  const scale = fit === 'cover'
    ? Math.max(viewportWidth / sourceWidth, viewportHeight / sourceHeight)
    : Math.min(viewportWidth / sourceWidth, viewportHeight / sourceHeight);
  const renderedWidth = sourceWidth * scale;
  const renderedHeight = sourceHeight * scale;
  return {
    scale,
    offsetX: (viewportWidth - renderedWidth) / 2,
    offsetY: (viewportHeight - renderedHeight) / 2,
    renderedWidth,
    renderedHeight,
  };
}

export function clientPointToNormalizedRegionPoint(
  point: MediaPoint,
  geometry: MediaFitGeometry,
): MediaPoint | null {
  const resolved = resolveFit(geometry);
  if (!resolved) return null;
  const x = (point.x - resolved.offsetX) / resolved.renderedWidth;
  const y = (point.y - resolved.offsetY) / resolved.renderedHeight;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return {
    x: precision(geometry.mirrored ? 1 - x : x),
    y: precision(y),
  };
}

export function normalizedRegionToViewportRect(
  region: NormalizedMediaRegion,
  geometry: MediaFitGeometry,
): MediaRect | null {
  const normalized = normalizeRegion(region);
  const resolved = resolveFit(geometry);
  if (!normalized || !resolved) return null;
  const sourceX = geometry.mirrored
    ? 1 - normalized.x - normalized.width
    : normalized.x;
  return {
    x: sourceX * resolved.renderedWidth + resolved.offsetX,
    y: normalized.y * resolved.renderedHeight + resolved.offsetY,
    width: normalized.width * resolved.renderedWidth,
    height: normalized.height * resolved.renderedHeight,
  };
}

export function normalizedDragRegion(start: MediaPoint, end: MediaPoint) {
  return normalizeRegion({
    x: start.x,
    y: start.y,
    width: end.x - start.x,
    height: end.y - start.y,
  });
}
