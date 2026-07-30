import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export function KnowledgeGraphWorkspace(props: {
  canvas: ReactNode;
  detail: ReactNode;
  detailOpen: boolean;
  detailTitle: string;
  onCloseDetail: () => void;
}) {
  return (
    <section
      data-testid="a3-knowledge-graph-workspace"
      className={cn(
        'relative grid h-[min(760px,calc(100dvh-13rem))] min-h-[560px] overflow-hidden',
        'max-md:h-[560px] max-md:min-h-[480px]',
        props.detailOpen && 'xl:grid-cols-[minmax(0,1fr)_380px]',
      )}
    >
      <div className="min-h-0 min-w-0">{props.canvas}</div>
      {props.detailOpen ? (
        <aside
          aria-label={props.detailTitle}
          className="absolute inset-y-0 right-0 z-20 flex w-[min(400px,92%)] flex-col border-l border-[var(--a3-border)] bg-[var(--a3-surface-solid)] shadow-xl xl:static xl:w-auto xl:shadow-none"
        >
          <div className="flex h-14 shrink-0 items-center justify-between border-b border-[var(--a3-border)] px-4">
            <h2 className="text-sm font-semibold text-[var(--a3-text)]">{props.detailTitle}</h2>
            <Button variant="ghost" size="icon" onClick={props.onCloseDetail} aria-label="关闭详情">
              <X className="size-4" />
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-4">{props.detail}</div>
        </aside>
      ) : null}
    </section>
  );
}
