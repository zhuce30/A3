export type A3SystemCheckStatus = 'ok' | 'warning' | 'error';

export interface A3SystemCheck {
  name: string;
  status: A3SystemCheckStatus;
  message: string;
  detail: Record<string, string | number | boolean | string[]>;
}

export interface A3SystemHealthResponse {
  success: boolean;
  error?: string;
  overallStatus: A3SystemCheckStatus;
  checks: A3SystemCheck[];
}
