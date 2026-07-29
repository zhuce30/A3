'use client';

import { useLayoutEffect, useRef, type ReactNode } from 'react';

type ClassroomComposerFrameProps = {
  children: ReactNode;
  onHeightChange: (height: number) => void;
};

export function ClassroomComposerFrame({
  children,
  onHeightChange,
}: ClassroomComposerFrameProps) {
  const frameRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;

    onHeightChange(Math.ceil(frame.getBoundingClientRect().height));

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) onHeightChange(Math.ceil(entry.contentRect.height));
    });
    observer.observe(frame);

    return () => observer.disconnect();
  }, [onHeightChange]);

  return (
    <div
      ref={frameRef}
      className="absolute inset-x-0 bottom-0 z-20 px-3 pb-2 md:px-6"
      data-testid="a3-classroom-composer-frame"
    >
      <div className="mx-auto rounded-lg border border-slate-200 bg-white p-1.5 shadow-lg">
        {children}
      </div>
    </div>
  );
}
