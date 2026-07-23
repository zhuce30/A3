'use client';

import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Focus, Loader2, Maximize2, Minimize2, ScanLine, ScanSearch, Trash2, Undo2 } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { Button } from '@/components/ui/button';
import type { BrowserDetectionCandidate } from '@/lib/a3/browser-vision/detector-types';
import type { NormalizedMediaRegion, RealtimeFocusedMedia } from '@/lib/a3/realtime-media-focus';
import { cn } from '@/lib/utils';
import { RealtimeRegionOverlay } from './realtime-region-overlay';
import { useRealtimeObjectDetection } from './use-realtime-object-detection';

type RealtimeMediaStageProps = {
  cameraEnabled: boolean;
  screenEnabled: boolean;
  cameraVideoRef: RefObject<HTMLVideoElement | null>;
  screenVideoRef: RefObject<HTMLVideoElement | null>;
  onAnalyze: (options: { source: 'camera' | 'screen'; region?: NormalizedMediaRegion }) => void | Promise<void>;
  onAvatarCoveredChange?: (covered: boolean) => void;
  children?: ReactNode;
};

export function reduceRealtimeMediaFocus(
  current: RealtimeFocusedMedia,
  command: 'camera' | 'screen' | 'escape',
  enabled: boolean,
): RealtimeFocusedMedia {
  if (command === 'escape') return null;
  if (!enabled) return current;
  return current === command ? null : command;
}

export function RealtimeMediaStage({
  cameraEnabled,
  screenEnabled,
  cameraVideoRef,
  screenVideoRef,
  onAnalyze,
  onAvatarCoveredChange,
  children,
}: RealtimeMediaStageProps) {
  const reduceMotion = useReducedMotion();
  const stageRef = useRef<HTMLDivElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const [focused, setFocused] = useState<RealtimeFocusedMedia>(null);
  const [selecting, setSelecting] = useState(false);
  const [detectionEnabled, setDetectionEnabled] = useState(false);
  const [selectedDetectionId, setSelectedDetectionId] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [regions, setRegions] = useState<Record<'camera' | 'screen', NormalizedMediaRegion | null>>({
    camera: null,
    screen: null,
  });
  const focusedVideoRef = focused === 'camera' ? cameraVideoRef : focused === 'screen' ? screenVideoRef : null;
  const detection = useRealtimeObjectDetection({
    enabled: detectionEnabled,
    active: Boolean(focused),
    source: focused,
    videoRef: focusedVideoRef,
    locked: Boolean(selectedDetectionId) || selecting,
  });

  const selectDetectionCandidate = useCallback((candidate: BrowserDetectionCandidate) => {
    if (!focused) return;
    setSelectedDetectionId(candidate.id);
    setSelecting(false);
    setRegions((current) => ({ ...current, [focused]: candidate.region }));
  }, [focused]);

  const updateManualRegion = useCallback((source: 'camera' | 'screen', region: NormalizedMediaRegion | null) => {
    setSelectedDetectionId(null);
    setRegions((current) => ({
      ...current,
      [source]: region ? { ...region, method: 'manual' } : null,
    }));
  }, []);

  const setMediaFocus = useCallback((source: 'camera' | 'screen', enabled: boolean) => {
    setSelectedDetectionId(null);
    setFocused((current) => {
      const next = reduceRealtimeMediaFocus(current, source, enabled);
      if (next && typeof document !== 'undefined') returnFocusRef.current = document.activeElement as HTMLElement | null;
      return next;
    });
    setSelecting(false);
  }, []);

  const clearFocus = useCallback(() => {
    setSelecting(false);
    setSelectedDetectionId(null);
    onAvatarCoveredChange?.(false);
    window.requestAnimationFrame(() => {
      setFocused(null);
      window.requestAnimationFrame(() => returnFocusRef.current?.focus());
    });
  }, [onAvatarCoveredChange]);

  useEffect(() => {
    if (!focused) {
      onAvatarCoveredChange?.(false);
      return;
    }
    const timer = window.setTimeout(() => onAvatarCoveredChange?.(true), reduceMotion ? 0 : 270);
    return () => window.clearTimeout(timer);
  }, [focused, onAvatarCoveredChange, reduceMotion]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (focused === 'camera' && !cameraEnabled) clearFocus();
      if (focused === 'screen' && !screenEnabled) clearFocus();
      if (!cameraEnabled) setRegions((current) => current.camera ? { ...current, camera: null } : current);
      if (!screenEnabled) setRegions((current) => current.screen ? { ...current, screen: null } : current);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [cameraEnabled, clearFocus, focused, screenEnabled]);

  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || !focused) return;
      if (selecting) setSelecting(false);
      else clearFocus();
    };
    const handleFullscreen = () => setFullscreen(document.fullscreenElement === stageRef.current);
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('fullscreenchange', handleFullscreen);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('fullscreenchange', handleFullscreen);
      onAvatarCoveredChange?.(false);
    };
  }, [clearFocus, focused, onAvatarCoveredChange, selecting]);

  const toggleFullscreen = async () => {
    if (!stageRef.current || !document.fullscreenEnabled) return;
    if (document.fullscreenElement) await document.exitFullscreen();
    else await stageRef.current.requestFullscreen();
  };

  const handleTileKey = (event: KeyboardEvent<HTMLDivElement>, source: 'camera' | 'screen', enabled: boolean) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    setMediaFocus(source, enabled);
  };

  const transition = reduceMotion
    ? { duration: 0 }
    : { duration: 0.26, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] };

  return (
    <div ref={stageRef} data-testid="a3-realtime-media-stage" className="relative min-h-[580px] flex-1 overflow-hidden rounded-[28px]">
      <div className="absolute inset-0 z-0">{children}</div>
      <MediaTile
        source="camera"
        label="摄像头"
        enabled={cameraEnabled}
        focused={focused}
        selecting={selecting}
        detectionCandidates={focused === 'camera' ? detection.candidates : []}
        selectedDetectionId={focused === 'camera' ? selectedDetectionId : null}
        region={regions.camera}
        videoRef={cameraVideoRef}
        transition={transition}
        onFocus={setMediaFocus}
        onKeyDown={handleTileKey}
        onRegionChange={(region) => updateManualRegion('camera', region)}
        onDetectionSelect={selectDetectionCandidate}
      />
      <MediaTile
        source="screen"
        label="屏幕"
        enabled={screenEnabled}
        focused={focused}
        selecting={selecting}
        detectionCandidates={focused === 'screen' ? detection.candidates : []}
        selectedDetectionId={focused === 'screen' ? selectedDetectionId : null}
        region={regions.screen}
        videoRef={screenVideoRef}
        transition={transition}
        onFocus={setMediaFocus}
        onKeyDown={handleTileKey}
        onRegionChange={(region) => updateManualRegion('screen', region)}
        onDetectionSelect={selectDetectionCandidate}
      />

      <AnimatePresence>
        {focused ? (
          <motion.div
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={transition}
            className="absolute right-4 top-4 z-[60] flex flex-wrap justify-end gap-2"
          >
            <Button
              data-testid="a3-realtime-detection-toggle"
              type="button"
              size="sm"
              variant="secondary"
              aria-pressed={detectionEnabled}
              onClick={() => setDetectionEnabled((value) => !value)}
              title="在浏览器本地识别人物、学习资料和可能的文档区域"
            >
              {detection.state.status === 'loading' ? <Loader2 className="size-4 animate-spin" /> : <ScanSearch className="size-4" />}
              {detectionEnabled ? '停止识别' : '识别目标'}
            </Button>
            <Button data-testid="a3-realtime-region-toggle" type="button" size="sm" variant="secondary" onClick={() => {
              setSelectedDetectionId(null);
              setSelecting((value) => !value);
            }} title="框选分析区域">
              <ScanLine className="size-4" />
              {selecting ? '完成框选' : '框选'}
            </Button>
            {regions[focused] ? (
              <Button type="button" size="sm" variant="secondary" onClick={() => {
                setSelectedDetectionId(null);
                setRegions((current) => ({ ...current, [focused]: null }));
              }} title="清除框选">
                <Trash2 className="size-4" />
              </Button>
            ) : null}
            <Button data-testid="a3-realtime-region-analyze" type="button" size="sm" variant="secondary" onClick={() => void onAnalyze({ source: focused, region: regions[focused] || undefined })} title="分析当前区域">
              <Focus className="size-4" />
              {regions[focused] ? '分析选区' : '分析画面'}
            </Button>
            <Button type="button" size="sm" variant="secondary" onClick={() => void toggleFullscreen()} disabled={!document.fullscreenEnabled} title={fullscreen ? '退出全屏' : '全屏'}>
              {fullscreen ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
            </Button>
            <Button data-testid="a3-realtime-focus-return" type="button" size="sm" variant="secondary" onClick={clearFocus} title="返回数字助教">
              <Undo2 className="size-4" />
              返回
            </Button>
            {detectionEnabled ? (
              <span
                data-testid="a3-realtime-detection-status"
                className={cn(
                  'inline-flex min-h-9 items-center rounded-lg border px-3 text-xs font-medium shadow-sm',
                  detection.state.status === 'error'
                    ? 'border-rose-200 bg-rose-50 text-rose-700'
                    : 'border-emerald-200 bg-emerald-50 text-emerald-700',
                )}
              >
                {detection.state.status === 'loading'
                  ? '正在加载本地识别模型'
                  : detection.state.status === 'error'
                    ? detection.state.error
                    : selectedDetectionId
                      ? '已锁定选区，清除后继续识别'
                      : `本地识别${detection.candidates.length ? ` · ${detection.candidates.length} 个候选` : '已开启'}`}
              </span>
            ) : null}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

type MediaTileProps = {
  source: 'camera' | 'screen';
  label: string;
  enabled: boolean;
  focused: RealtimeFocusedMedia;
  selecting: boolean;
  detectionCandidates: BrowserDetectionCandidate[];
  selectedDetectionId: string | null;
  region: NormalizedMediaRegion | null;
  videoRef: RefObject<HTMLVideoElement | null>;
  transition: { duration: number; ease?: [number, number, number, number] };
  onFocus: (source: 'camera' | 'screen', enabled: boolean) => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>, source: 'camera' | 'screen', enabled: boolean) => void;
  onRegionChange: (region: NormalizedMediaRegion | null) => void;
  onDetectionSelect: (candidate: BrowserDetectionCandidate) => void;
};

function MediaTile({
  source,
  label,
  enabled,
  focused,
  selecting,
  detectionCandidates,
  selectedDetectionId,
  region,
  videoRef,
  transition,
  onFocus,
  onKeyDown,
  onRegionChange,
  onDetectionSelect,
}: MediaTileProps) {
  const isFocused = focused === source;
  const previewTop = source === 'camera' ? 96 : 204;
  return (
    <motion.div
      layout
      transition={transition}
      role="button"
      tabIndex={enabled ? 0 : -1}
      aria-label={`${label}${enabled ? '，点击放大' : '，未开启'}`}
      aria-pressed={isFocused}
      data-testid={`a3-realtime-${source}-tile`}
      data-focused={isFocused ? 'true' : 'false'}
      onClick={() => {
        if (!isFocused && enabled) onFocus(source, enabled);
      }}
      onKeyDown={(event) => onKeyDown(event, source, enabled)}
      className={cn(
        'absolute overflow-hidden border border-white/35 bg-black shadow-[0_14px_36px_rgba(15,23,42,0.26)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300',
        isFocused ? 'z-40 rounded-[28px]' : 'z-30 rounded-2xl',
      )}
      style={isFocused
        ? { inset: 0 }
        : { top: previewTop, right: 24, width: 244, height: 96 }}
    >
      <video
        ref={videoRef}
        data-testid={`a3-realtime-${source}-preview`}
        autoPlay
        playsInline
        muted
        className={cn(
          'size-full bg-black',
          isFocused ? 'object-contain' : 'object-cover',
          !enabled && 'opacity-40',
        )}
      />
      <div className="pointer-events-none absolute left-3 top-3 z-30 rounded-full bg-slate-950/75 px-3 py-1 text-xs font-medium text-white">
        {label}
      </div>
      {!enabled ? (
        <div className="absolute inset-0 flex items-center justify-center bg-slate-950/72 text-xs text-slate-300">未开启</div>
      ) : null}
      {isFocused ? (
        <RealtimeRegionOverlay
          enabled={selecting}
          videoRef={videoRef}
          region={region}
          onChange={onRegionChange}
          fit="contain"
          mirrored={source === 'camera'}
          detectionCandidates={selecting ? [] : detectionCandidates}
          selectedDetectionId={selectedDetectionId}
          onDetectionSelect={onDetectionSelect}
        />
      ) : null}
    </motion.div>
  );
}
