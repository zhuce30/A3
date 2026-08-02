import { normalizeRegion } from '../realtime-media-focus';
import type {
  BrowserDetectionCandidate,
  BrowserDetectionFrame,
  BrowserDetectionResult,
  BrowserDetectionState,
  BrowserObjectDetectorAdapter,
  RawBrowserDetectionCandidate,
} from './detector-types';

const DEFAULT_FPS = 3;
const MAX_FPS = 5;
const APPROVED_CATEGORIES: Record<string, string> = {
  person: '人物',
  book: '书本或学习资料',
  laptop: '笔记本电脑',
  'cell phone': '手机',
  tv: '显示屏',
  monitor: '显示屏',
  document: '可能的文档区域',
};

type ControllerOptions = {
  fps?: number;
  minimumConfidence?: number;
  maxResults?: number;
  candidateHoldMs?: number;
  onCandidates?: (candidates: BrowserDetectionCandidate[]) => void;
  onStateChange?: (state: BrowserDetectionState) => void;
};

export function normalizeDetectionFps(value: number | undefined) {
  if (!Number.isFinite(value)) return DEFAULT_FPS;
  return Math.min(MAX_FPS, Math.max(1, Math.round(value as number)));
}

export function sanitizeDetectionCandidates(
  rawCandidates: RawBrowserDetectionCandidate[],
  options: { minimumConfidence?: number; maxResults?: number } = {},
) {
  const minimumConfidence = Math.min(1, Math.max(0, options.minimumConfidence ?? 0.5));
  const maxResults = Math.min(8, Math.max(1, Math.round(options.maxResults ?? 5)));
  return rawCandidates
    .filter((candidate) => APPROVED_CATEGORIES[candidate.category.toLowerCase()])
    .filter((candidate) => Number.isFinite(candidate.confidence) && candidate.confidence >= minimumConfidence)
    .sort((left, right) => right.confidence - left.confidence)
    .flatMap((candidate, index): BrowserDetectionCandidate[] => {
      const category = candidate.category.toLowerCase();
      const label = APPROVED_CATEGORIES[category];
      const method = candidate.method === 'document_proposal' || category === 'document'
        ? 'document_proposal'
        : 'object_detection';
      const confidence = Math.round(Math.min(1, candidate.confidence) * 10_000) / 10_000;
      const region = normalizeRegion({
        ...candidate.region,
        label,
        confidence,
        method,
      });
      if (!region) return [];
      return [{
        id: `${category.replace(/[^a-z0-9]+/g, '-')}-${index}`,
        category,
        label,
        confidence,
        method,
        region,
      }];
    })
    .slice(0, maxResults);
}

export class RealtimeObjectDetectionController {
  private state: BrowserDetectionState = { status: 'idle', manualSelectionAvailable: true };
  private context = { active: true, hidden: false, locked: false };
  private inFlight = false;
  private lastStartedAt = Number.NEGATIVE_INFINITY;
  private lastCandidateAt = Number.NEGATIVE_INFINITY;
  private lastCandidateSource: BrowserDetectionFrame['source'] | null = null;
  private lastCandidates: BrowserDetectionCandidate[] = [];
  private disposed = false;
  private readonly intervalMs: number;
  private readonly candidateHoldMs: number;

  constructor(
    private readonly adapter: BrowserObjectDetectorAdapter,
    private readonly options: ControllerOptions = {},
  ) {
    this.intervalMs = 1_000 / normalizeDetectionFps(options.fps);
    this.candidateHoldMs = Math.min(3_000, Math.max(0, options.candidateHoldMs ?? 1_200));
  }

  getState() {
    return { ...this.state };
  }

  private setState(state: BrowserDetectionState) {
    this.state = state;
    this.options.onStateChange?.({ ...state });
  }

  async enable() {
    if (this.disposed) return false;
    if (this.state.status === 'ready') return true;
    this.setState({ status: 'loading', manualSelectionAvailable: true });
    try {
      const capability = await this.adapter.load();
      if (this.disposed) return false;
      this.setState({ status: 'ready', backend: capability.backend, manualSelectionAvailable: true });
      return true;
    } catch (error) {
      console.error('[A3 browser vision] Failed to load the local detector.', error);
      if (!this.disposed) {
        this.setState({
          status: 'error',
          error: '自动识别暂不可用，请使用手动画框。',
          manualSelectionAvailable: true,
        });
      }
      return false;
    }
  }

  setContext(context: { active: boolean; hidden: boolean; locked: boolean }) {
    this.context = { ...context };
  }

  async detect(frame: BrowserDetectionFrame, timestampMs: number): Promise<BrowserDetectionResult> {
    if (this.disposed || this.state.status !== 'ready') return rejected('not_ready');
    if (!this.context.active) return rejected('inactive');
    if (this.context.hidden) return rejected('hidden');
    if (this.context.locked) return rejected('locked');
    if (this.inFlight) return rejected('in_flight');
    if (timestampMs - this.lastStartedAt < this.intervalMs) return rejected('throttled');

    this.inFlight = true;
    this.lastStartedAt = timestampMs;
    try {
      const rawCandidates = await this.adapter.detect(frame, timestampMs);
      if (this.disposed) return rejected('not_ready');
      const detectedCandidates = sanitizeDetectionCandidates(rawCandidates, this.options);
      const candidates = this.resolveVisibleCandidates(detectedCandidates, frame.source, timestampMs);
      this.options.onCandidates?.(candidates);
      return { accepted: true, candidates };
    } catch (error) {
      if (this.disposed) return rejected('not_ready');
      console.error('[A3 browser vision] Local detection failed.', error);
      this.setState({
        status: 'error',
        error: '自动识别暂不可用，请使用手动画框。',
        manualSelectionAvailable: true,
      });
      return rejected('failed');
    } finally {
      this.inFlight = false;
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.lastCandidates = [];
    this.lastCandidateSource = null;
    this.lastCandidateAt = Number.NEGATIVE_INFINITY;
    this.adapter.dispose();
    this.setState({ status: 'idle', manualSelectionAvailable: true });
  }

  private resolveVisibleCandidates(
    candidates: BrowserDetectionCandidate[],
    source: BrowserDetectionFrame['source'],
    timestampMs: number,
  ) {
    if (source !== this.lastCandidateSource) {
      this.lastCandidates = [];
      this.lastCandidateAt = Number.NEGATIVE_INFINITY;
      this.lastCandidateSource = source;
    }
    if (candidates.length > 0) {
      this.lastCandidates = candidates;
      this.lastCandidateAt = timestampMs;
      return candidates;
    }
    if (timestampMs - this.lastCandidateAt <= this.candidateHoldMs) {
      return this.lastCandidates;
    }
    this.lastCandidates = [];
    return [];
  }
}

function rejected(reason: BrowserDetectionResult['reason']): BrowserDetectionResult {
  return { accepted: false, reason, candidates: [] };
}
