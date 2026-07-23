import { normalizeRegion, type NormalizedMediaRegion } from './realtime-media-focus';

export type CapturedRealtimeFrame = {
  imageDataUrl: string;
  source: { x: number; y: number; width: number; height: number };
  output: { width: number; height: number };
};

export function captureRealtimeVideoFrame(
  video: HTMLVideoElement,
  region?: NormalizedMediaRegion,
  createCanvas: () => HTMLCanvasElement = () => document.createElement('canvas'),
  maxDimension = 960,
): CapturedRealtimeFrame {
  if (!video.videoWidth || !video.videoHeight) {
    throw new Error('画面尚未加载完成');
  }
  const normalized = region ? normalizeRegion(region) : null;
  if (region && !normalized) throw new Error('选择区域无效，请重新框选');

  const source = normalized
    ? {
        x: Math.round(normalized.x * video.videoWidth),
        y: Math.round(normalized.y * video.videoHeight),
        width: Math.max(1, Math.round(normalized.width * video.videoWidth)),
        height: Math.max(1, Math.round(normalized.height * video.videoHeight)),
      }
    : { x: 0, y: 0, width: video.videoWidth, height: video.videoHeight };
  source.width = Math.min(source.width, video.videoWidth - source.x);
  source.height = Math.min(source.height, video.videoHeight - source.y);

  const scale = Math.min(1, maxDimension / Math.max(source.width, source.height));
  const output = {
    width: Math.max(1, Math.round(source.width * scale)),
    height: Math.max(1, Math.round(source.height * scale)),
  };
  const canvas = createCanvas();
  canvas.width = output.width;
  canvas.height = output.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('当前浏览器无法读取画面帧');
  context.drawImage(
    video,
    source.x,
    source.y,
    source.width,
    source.height,
    0,
    0,
    output.width,
    output.height,
  );
  return {
    imageDataUrl: canvas.toDataURL('image/jpeg', 0.72),
    source,
    output,
  };
}
