import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react';
import type { JSX } from 'react';
import type { MaterialRelationEdgeData } from './material-types';

export function MaterialRelationEdge(props: EdgeProps): JSX.Element {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, style, data } = props;
  const edgeData = (data ?? {}) as Partial<MaterialRelationEdgeData>;
  const [edgePath, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  const selected = Boolean(edgeData.selected);
  const muted = Boolean(edgeData.muted);
  const showLabel = Boolean(edgeData.showLabel);
  const color = edgeData.color || '#64748b';
  const label = edgeData.label || edgeData.relationType || '关联';

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        className="a3-material-relation-edge"
        data-testid="a3-material-relation-edge"
        style={{
          ...style,
          stroke: color,
          strokeWidth: selected ? 3.2 : muted ? 1.1 : 2,
          opacity: selected ? 1 : muted ? 0.2 : 0.76,
          filter: selected ? `drop-shadow(0 4px 8px ${color}55)` : muted ? undefined : `drop-shadow(0 1px 3px ${color}22)`,
          transition: 'opacity 180ms cubic-bezier(0.16, 1, 0.3, 1), stroke-width 180ms cubic-bezier(0.16, 1, 0.3, 1), filter 180ms cubic-bezier(0.16, 1, 0.3, 1)',
        }}
      />
      {(() => {
        if (!showLabel) return null;
        return (
          <EdgeLabelRenderer>
            <div
              data-testid="a3-material-relation-label"
              className="a3-material-relation-label pointer-events-none absolute max-w-[150px] truncate rounded-full border bg-[var(--a3-surface-solid)] px-2.5 py-1 text-[11px] shadow-sm"
              style={{
                transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
                borderColor: selected ? color : 'rgba(148, 163, 184, 0.55)',
                color,
                fontWeight: selected ? 700 : 600,
                opacity: selected ? 1 : muted ? 0.18 : 0.9,
                boxShadow: selected ? `0 8px 22px ${color}22` : '0 6px 18px rgba(15, 23, 42, 0.08)',
                transition: 'opacity 180ms cubic-bezier(0.16, 1, 0.3, 1), box-shadow 180ms cubic-bezier(0.16, 1, 0.3, 1)',
              }}
            >
              {label}
            </div>
          </EdgeLabelRenderer>
        );
      })()}
    </>
  );
}
