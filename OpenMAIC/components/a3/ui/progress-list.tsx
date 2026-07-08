import { CheckCircle2, Circle } from 'lucide-react';
import { Progress } from '@/components/ui/progress';
import type { A3Task } from '@/lib/a3/types';
import { cn } from '@/lib/utils';
import { A3Pill } from './a3-card';

export function ProgressList({ items }: { items: A3Task[] }) {
  return (
    <div className="space-y-4">
      {items.map((item) => (
        <div key={item.title} className="space-y-2">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="truncate text-sm font-medium text-slate-900">{item.title}</div>
              <div className="mt-1 text-xs text-slate-500">{item.subtitle}</div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <A3Pill
                tone={
                  item.status === '已完成' ? 'green' : item.status === '进行中' ? 'blue' : 'slate'
                }
              >
                {item.status}
              </A3Pill>
              {item.status === '已完成' ? (
                <CheckCircle2 className="size-4 text-emerald-500" />
              ) : (
                <Circle className="size-4 text-slate-300" />
              )}
            </div>
          </div>
          <Progress
            value={item.progress}
            className={cn(
              'h-2 bg-slate-100',
              item.progress < 50 && '[&_[data-slot=progress-indicator]]:bg-orange-500',
              item.progress >= 50 &&
                item.progress < 80 &&
                '[&_[data-slot=progress-indicator]]:bg-blue-500',
              item.progress >= 80 && '[&_[data-slot=progress-indicator]]:bg-emerald-500',
            )}
          />
        </div>
      ))}
    </div>
  );
}
