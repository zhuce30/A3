'use client';

import { Database, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import type { MaterialGraphDepth } from './material-focused-flow';
import { MaterialGraphDataStatus } from './material-graph-panels';
import type { MaterialGraph, MaterialNode } from './material-types';
import { materialTypeLabel } from './material-types';

export type KnowledgeGraphTab = 'material' | 'course';

export type KnowledgeGraphToolbarProps = {
  activeTab: KnowledgeGraphTab;
  onTabChange: (tab: KnowledgeGraphTab) => void;
  query: string;
  onQueryChange: (value: string) => void;
  searchMatches: MaterialNode[];
  onSelectSearchResult: (nodeId: string) => void;
  depth: MaterialGraphDepth;
  onDepthChange: (depth: MaterialGraphDepth) => void;
  onReset: () => void;
  loading: boolean;
};

export function KnowledgeGraphToolbar(props: KnowledgeGraphToolbarProps) {
  return (
    <div className="flex flex-col gap-3 border-b border-[var(--a3-border)] px-4 py-3 lg:flex-row lg:items-center">
      <div role="tablist" aria-label="知识关系视图" className="inline-flex w-fit rounded-md bg-[var(--a3-surface-muted)] p-1">
        <GraphTabButton active={props.activeTab === 'material'} onClick={() => props.onTabChange('material')}>
          资料图谱
        </GraphTabButton>
        <GraphTabButton active={props.activeTab === 'course'} onClick={() => props.onTabChange('course')}>
          课程路径
        </GraphTabButton>
      </div>

      {props.activeTab === 'material' ? (
        <>
          <MaterialGraphSearch
            query={props.query}
            matches={props.searchMatches}
            onQueryChange={props.onQueryChange}
            onSelect={props.onSelectSearchResult}
            disabled={props.loading}
          />
          <GraphDepthControl depth={props.depth} onChange={props.onDepthChange} disabled={props.loading} />
          <Button variant="ghost" size="sm" onClick={props.onReset} disabled={props.loading}>
            重置
          </Button>
        </>
      ) : null}
    </div>
  );
}

export function GraphDataStatusPopover({ graph }: { graph: MaterialGraph | null }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm">
          <Database className="size-4" />
          数据状态
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-auto p-4">
        <MaterialGraphDataStatus graph={graph} />
      </PopoverContent>
    </Popover>
  );
}

function GraphTabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        'min-h-8 rounded px-3 text-sm font-medium transition-colors',
        active ? 'bg-[var(--a3-surface-solid)] text-blue-700 shadow-sm' : 'text-[var(--a3-text-muted)] hover:text-[var(--a3-text)]',
      )}
    >
      {children}
    </button>
  );
}

function GraphDepthControl(props: {
  depth: MaterialGraphDepth;
  onChange: (depth: MaterialGraphDepth) => void;
  disabled: boolean;
}) {
  const options: Array<{ depth: MaterialGraphDepth; id: string; label: string }> = [
    { depth: 'one', id: 'a3-material-graph-depth-one', label: '一跳' },
    { depth: 'two', id: 'a3-material-graph-depth-two', label: '二跳' },
    { depth: 'all', id: 'a3-material-graph-depth-all', label: '全部' },
  ];

  return (
    <div role="group" aria-label="关系范围" className="inline-flex rounded-md border border-[var(--a3-border)] p-0.5">
      {options.map((option) => (
        <button
          key={option.depth}
          type="button"
          data-testid={option.id}
          disabled={props.disabled}
          aria-pressed={props.depth === option.depth}
          onClick={() => props.onChange(option.depth)}
          className={cn(
            'min-h-8 rounded px-3 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
            props.depth === option.depth ? 'bg-blue-50 text-blue-700' : 'text-[var(--a3-text-muted)] hover:bg-[var(--a3-surface-muted)]',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function MaterialGraphSearch(props: {
  query: string;
  matches: MaterialNode[];
  onQueryChange: (value: string) => void;
  onSelect: (nodeId: string) => void;
  disabled: boolean;
}) {
  const open = props.query.trim().length > 0;

  return (
    <div className="relative min-w-0 flex-1 lg:max-w-md">
      <label className="flex min-h-9 items-center gap-2 rounded-md border border-[var(--a3-border)] bg-[var(--a3-surface-solid)] px-3">
        <Search className="size-4 shrink-0 text-[var(--a3-text-muted)]" />
        <input
          role="combobox"
          aria-label="搜索当前视图中的实体"
          aria-expanded={open}
          value={props.query}
          disabled={props.disabled}
          onChange={(event) => props.onQueryChange(event.target.value)}
          placeholder="搜索当前视图中的实体"
          className="min-w-0 flex-1 bg-transparent text-sm text-[var(--a3-text)] outline-none placeholder:text-[var(--a3-text-muted)]"
        />
      </label>
      {open ? (
        <div
          role="listbox"
          className="absolute left-0 right-0 top-full z-30 mt-1 max-h-64 overflow-y-auto rounded-md border border-[var(--a3-border)] bg-[var(--a3-surface-solid)] p-1 shadow-lg"
        >
          {props.matches.length ? (
            props.matches.map((node) => (
              <button
                key={node.id}
                role="option"
                aria-selected={false}
                type="button"
                onClick={() => props.onSelect(node.id)}
                className="block w-full rounded px-3 py-2 text-left hover:bg-[var(--a3-surface-muted)]"
              >
                <span className="block truncate text-sm font-medium text-[var(--a3-text)]">{node.label}</span>
                <span className="block truncate text-xs text-[var(--a3-text-muted)]">
                  {node.summary || materialTypeLabel[node.type] || node.type}
                </span>
              </button>
            ))
          ) : (
            <div className="px-3 py-2 text-sm text-[var(--a3-text-muted)]">当前视图没有匹配实体</div>
          )}
        </div>
      ) : null}
    </div>
  );
}
