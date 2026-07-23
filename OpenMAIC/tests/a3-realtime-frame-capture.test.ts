import { describe, expect, it, vi } from 'vitest';
import { captureRealtimeVideoFrame } from '@/lib/a3/realtime-frame-capture';

describe('A3 realtime frame capture', () => {
  it('crops a normalized source region before applying the output bound', () => {
    const drawImage = vi.fn();
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({ drawImage }),
      toDataURL: () => 'data:image/jpeg;base64,test',
    };
    const result = captureRealtimeVideoFrame(
      { videoWidth: 1920, videoHeight: 1080 } as HTMLVideoElement,
      { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
      () => canvas as unknown as HTMLCanvasElement,
    );

    expect(result.imageDataUrl).toBe('data:image/jpeg;base64,test');
    expect(result.output).toEqual({ width: 960, height: 540 });
    expect(drawImage).toHaveBeenCalledWith(
      expect.anything(),
      480,
      270,
      960,
      540,
      0,
      0,
      960,
      540,
    );
  });

  it('keeps whole-frame capture compatible', () => {
    const drawImage = vi.fn();
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({ drawImage }),
      toDataURL: () => 'data:image/jpeg;base64,test',
    };
    captureRealtimeVideoFrame(
      { videoWidth: 640, videoHeight: 360 } as HTMLVideoElement,
      undefined,
      () => canvas as unknown as HTMLCanvasElement,
    );
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 640, 360, 0, 0, 640, 360);
  });
});
