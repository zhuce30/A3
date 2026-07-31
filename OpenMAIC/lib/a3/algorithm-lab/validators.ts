import type { ValidationResult } from './contracts';

const isIntegerInRange = (value: unknown, minimum: number, maximum: number): boolean =>
  typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maximum;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const resultFromErrors = (errors: string[]): ValidationResult => ({
  valid: errors.length === 0,
  errors,
});

export function validateCpuSchedulingInput(input: unknown): ValidationResult {
  const errors: string[] = [];
  const inputRecord = isRecord(input) ? input : null;
  const processes = inputRecord?.processes;

  if (!Array.isArray(processes)) {
    errors.push('进程列表必须是数组');
  } else if (processes.length < 1 || processes.length > 12) {
    errors.push('进程数量必须是 1 到 12 个');
  }

  const processIds = new Set<string>();
  let hasBlankProcessId = false;
  let hasDuplicateProcessId = false;
  let hasInvalidArrivalTime = false;
  let hasInvalidBurstTime = false;
  let hasInvalidPriority = false;
  let hasInvalidProcessRow = false;

  if (Array.isArray(processes)) {
    for (let index = 0; index < processes.length; index += 1) {
      const process = processes[index];
      if (!isRecord(process)) {
        hasInvalidProcessRow = true;
        continue;
      }

      const normalizedId = typeof process.processId === 'string' ? process.processId.trim() : '';
      if (!normalizedId) {
        hasBlankProcessId = true;
      } else if (processIds.has(normalizedId)) {
        hasDuplicateProcessId = true;
      } else {
        processIds.add(normalizedId);
      }

      hasInvalidArrivalTime ||= !isIntegerInRange(process.arrivalTime, 0, 100);
      hasInvalidBurstTime ||= !isIntegerInRange(process.burstTime, 1, 100);
      hasInvalidPriority ||= !isIntegerInRange(process.priority, 0, 99);
    }
  }

  if (hasInvalidProcessRow) errors.push('每个进程必须是对象');
  if (hasBlankProcessId) errors.push('进程编号不能为空');
  if (hasDuplicateProcessId) errors.push('进程编号不能重复');
  if (hasInvalidArrivalTime) errors.push('到达时间必须是 0 到 100 之间的整数');
  if (hasInvalidBurstTime) errors.push('运行时间必须是 1 到 100 之间的整数');
  if (hasInvalidPriority) errors.push('优先级必须是 0 到 99 之间的整数');
  if (!isIntegerInRange(inputRecord?.timeQuantum, 1, 20)) {
    errors.push('时间片必须是 1 到 20 之间的整数');
  }

  return resultFromErrors(errors);
}

export function validatePageReplacementInput(input: unknown): ValidationResult {
  const errors: string[] = [];
  const inputRecord = isRecord(input) ? input : null;
  const referenceString = inputRecord?.referenceString;

  if (!Array.isArray(referenceString)) {
    errors.push('页面引用串必须是数组');
  } else if (referenceString.length < 1 || referenceString.length > 60) {
    errors.push('页面引用串长度必须是 1 到 60');
  }

  if (Array.isArray(referenceString)) {
    for (let index = 0; index < referenceString.length; index += 1) {
      if (!isIntegerInRange(referenceString[index], 0, 999)) {
        errors.push('页面编号必须是 0 到 999 之间的整数');
        break;
      }
    }
  }

  if (!isIntegerInRange(inputRecord?.frameCount, 1, 8)) {
    errors.push('页框数必须是 1 到 8 之间的整数');
  }

  return resultFromErrors(errors);
}
