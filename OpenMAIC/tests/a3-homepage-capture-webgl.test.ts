import { chromium } from '@playwright/test';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

async function loadAssetPipeline() {
  return (await import('../scripts/a3-homepage-asset-pipeline.mjs')) as {
    A3_DIGITAL_HUMAN_CAPTURE_STYLE: string;
    captureCanvasCompositor: (
      canvas: import('@playwright/test').Locator,
      options?: { maxAttempts?: number; retryDelayMs?: number; screenshotStyle?: string },
    ) => Promise<Buffer>;
    inspectRasterBuffer: (buffer: Buffer) => Promise<{
      alphaRatio: number;
      luminanceVariance: number;
      valid: boolean;
    }>;
  };
}

describe('A3 homepage WebGL compositor capture', () => {
  it('captures the compositor even when canvas.toDataURL is overridden with an empty result', async () => {
    const { A3_DIGITAL_HUMAN_CAPTURE_STYLE, captureCanvasCompositor, inspectRasterBuffer } =
      await loadAssetPipeline();
    const browser = await chromium.launch();
    const page = await browser.newPage();

    try {
      await page.setContent(
        '<div data-testid="a3-digital-human-avatar" style="position:relative;width:128px;height:128px;background:#fff"><div id="outer-overlay" style="position:absolute;inset:0;background:#000;z-index:20"></div><div data-testid="a3-digital-human-three-stage" style="position:relative;width:128px;height:128px"><canvas id="avatar" data-testid="a3-digital-human-three-canvas" width="128" height="128"></canvas><div id="stage-overlay" style="position:absolute;inset:64px 0 0;background:#000;z-index:2"></div></div></div>',
      );
      await page.evaluate(() => {
        const canvas = document.querySelector<HTMLCanvasElement>('#avatar');
        if (!canvas) throw new Error('canvas missing');
        const gl = canvas.getContext('webgl', { preserveDrawingBuffer: true });
        if (!gl) throw new Error('WebGL unavailable');
        const render = () => {
          gl.clearColor(0.08, 0.62, 0.9, 1);
          gl.clear(gl.COLOR_BUFFER_BIT);
          requestAnimationFrame(render);
        };
        render();
        HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,';
      });
      await page.waitForTimeout(100);

      const png = await captureCanvasCompositor(page.locator('#avatar'), {
        maxAttempts: 2,
        retryDelayMs: 0,
        screenshotStyle: A3_DIGITAL_HUMAN_CAPTURE_STYLE,
      });
      await expect(inspectRasterBuffer(png)).resolves.toMatchObject({ valid: true });
      const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
      let blackPixels = 0;
      for (let index = 0; index < data.length; index += info.channels) {
        const [red, green, blue] = [data[index], data[index + 1], data[index + 2]];
        if (red < 20 && green < 20 && blue < 20) blackPixels += 1;
      }
      expect(blackPixels).toBeLessThan(100);
    } finally {
      await browser.close();
    }
  }, 15_000);

  it('fails after the configured number of attempts when compositor frames stay blank', async () => {
    const { captureCanvasCompositor } = await loadAssetPipeline();
    const browser = await chromium.launch();
    const page = await browser.newPage();

    try {
      await page.setContent(
        '<style>html,body{margin:0;background:#fff}</style><canvas id="blank" width="128" height="128"></canvas>',
      );
      await expect(
        captureCanvasCompositor(page.locator('#blank'), { maxAttempts: 3, retryDelayMs: 0 }),
      ).rejects.toThrow('stayed blank after 3 attempts');
    } finally {
      await browser.close();
    }
  }, 15_000);
});
