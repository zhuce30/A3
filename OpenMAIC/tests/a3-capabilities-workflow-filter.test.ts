import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildAgentTraceWorkflowOptions } from '../components/a3/features/capabilities-view';

const viewPath = path.resolve(process.cwd(), 'components/a3/features/capabilities-view.tsx');

describe('A3 capabilities workflow filter', () => {
  it('defaults the trace waterfall to resource_generate and derives workflow filters from real agent runs', () => {
    const source = fs.readFileSync(viewPath, 'utf8');

    expect(source).toContain("useState('resource_generate')");
    expect(source).toContain('data-testid="a3-agent-trace-workflow-filter"');
    expect(source).toContain('runs.filter((run) => run.workflow === workflowFilter)');

    const options = buildAgentTraceWorkflowOptions([
      { workflow: 'openmaic_video_bridge' },
      { workflow: 'resource_generate' },
      { workflow: 'openmaic_classroom_bridge' },
    ] as never);
    expect(options).toEqual(['all', 'resource_generate', 'openmaic_video_bridge', 'openmaic_classroom_bridge']);
  });
});
