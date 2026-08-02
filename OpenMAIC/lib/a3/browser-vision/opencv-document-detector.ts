import type { CV } from '@techstark/opencv-js';
import { buildDocumentProposals, type DocumentContourCandidate } from './document-proposals';
import type { RawBrowserDetectionCandidate } from './detector-types';

const OPENCV_SCRIPT_URL = '/vendor/opencv/5.0.0/opencv.js';
let openCvPromise: Promise<CV> | null = null;
let openCvRuntime: CV | null = null;

type OpenCvWindow = Window & { cv?: CV | Promise<CV> };

export function preloadOpenCvDocumentDetector() {
  if (typeof window === 'undefined') return Promise.reject(new Error('OpenCV requires a browser'));
  if (openCvRuntime) return Promise.resolve(openCvRuntime);
  if (openCvPromise) return openCvPromise;
  openCvPromise = new Promise<CV>((resolve, reject) => {
    const finish = async () => {
      try {
        const candidate = (window as OpenCvWindow).cv;
        if (!candidate) throw new Error('OpenCV runtime missing');
        const runtime = candidate instanceof Promise ? await candidate : candidate;
        if (runtime.Mat) {
          openCvRuntime = runtime;
          resolve(runtime);
          return;
        }
        const initializable = runtime as CV & { onRuntimeInitialized?: () => void };
        initializable.onRuntimeInitialized = () => {
          openCvRuntime = runtime;
          resolve(runtime);
        };
      } catch (error) {
        openCvPromise = null;
        reject(error);
      }
    };
    const existing = document.querySelector<HTMLScriptElement>(`script[data-a3-opencv="${OPENCV_SCRIPT_URL}"]`);
    if (existing) {
      if ((window as OpenCvWindow).cv) void finish();
      else existing.addEventListener('load', () => void finish(), { once: true });
      existing.addEventListener('error', () => reject(new Error('OpenCV asset failed to load')), { once: true });
      return;
    }
    const script = document.createElement('script');
    script.src = OPENCV_SCRIPT_URL;
    script.async = true;
    script.dataset.a3Opencv = OPENCV_SCRIPT_URL;
    script.addEventListener('load', () => void finish(), { once: true });
    script.addEventListener('error', () => {
      openCvPromise = null;
      reject(new Error('OpenCV asset failed to load'));
    }, { once: true });
    document.head.appendChild(script);
  });
  return openCvPromise;
}

export function detectDocumentRegions(
  video: HTMLVideoElement,
  source: 'camera' | 'screen' = 'camera',
): RawBrowserDetectionCandidate[] {
  const cv = openCvRuntime;
  if (!cv || !video.videoWidth || !video.videoHeight) return [];
  const canvas = document.createElement('canvas');
  const scale = Math.min(1, 416 / Math.max(video.videoWidth, video.videoHeight));
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return [];
  context.drawImage(video, 0, 0, canvas.width, canvas.height);

  const sourceMat = cv.imread(canvas);
  const gray = new cv.Mat();
  const blurred = new cv.Mat();
  const edges = new cv.Mat();
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  const contourCandidates: DocumentContourCandidate[] = [];
  try {
    cv.cvtColor(sourceMat, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0, 0, cv.BORDER_DEFAULT);
    cv.Canny(blurred, edges, 60, 160);
    cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    for (let index = 0; index < contours.size(); index += 1) {
      const contour = contours.get(index);
      const approximation = new cv.Mat();
      try {
        const perimeter = cv.arcLength(contour, true);
        cv.approxPolyDP(contour, approximation, perimeter * 0.025, true);
        const rect = cv.boundingRect(approximation);
        contourCandidates.push({
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          area: Math.abs(cv.contourArea(approximation, false)),
          convex: Boolean(cv.isContourConvex(approximation)),
          vertices: approximation.rows,
        });
      } finally {
        contour.delete();
        approximation.delete();
      }
    }
  } finally {
    sourceMat.delete();
    gray.delete();
    blurred.delete();
    edges.delete();
    contours.delete();
    hierarchy.delete();
  }

  return buildDocumentProposals(contourCandidates, { width: canvas.width, height: canvas.height, source })
    .map((candidate) => ({
      category: 'document',
      confidence: candidate.confidence,
      region: candidate.region,
      method: 'document_proposal',
    }));
}
