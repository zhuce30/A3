import type { ReactNode } from 'react';

export function ResourceWorkbenchShell({ main, rail }: { main: ReactNode; rail: ReactNode }) {
  return (
    <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_320px]" data-testid="a3-resource-workbench-shell">
      <div className="min-w-0 space-y-5">{main}</div>
      <aside className="min-w-0 space-y-4 xl:sticky xl:top-24">{rail}</aside>
    </div>
  );
}
