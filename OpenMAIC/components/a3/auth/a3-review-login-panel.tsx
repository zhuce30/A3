'use client';

import { ClipboardCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';

const REVIEW_IDENTIFIER = '13800000001';
const REVIEW_PASSWORD = 'Demo@123456';

type A3ReviewLoginPanelProps = {
  onFill: (credentials: { identifier: string; password: string }) => void;
};

export function A3ReviewLoginPanel({ onFill }: A3ReviewLoginPanelProps) {
  return (
    <section
      data-testid="a3-review-login-panel"
      className="mb-6 border border-emerald-200 bg-emerald-50 p-4 text-emerald-950"
    >
      <div className="flex items-start gap-3">
        <ClipboardCheck className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">评审体验</h2>
          <p className="mt-1 text-sm leading-6 text-emerald-800">
            使用预置学生账号查看完整学习流程。登录仍会调用真实认证接口。
          </p>
          <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs">
            <span>账号：{REVIEW_IDENTIFIER}</span>
            <span>密码：{REVIEW_PASSWORD}</span>
          </div>
          <Button
            type="button"
            size="sm"
            data-testid="a3-review-fill-account"
            className="mt-4 bg-emerald-700 text-white hover:bg-emerald-800"
            onClick={() => onFill({ identifier: REVIEW_IDENTIFIER, password: REVIEW_PASSWORD })}
          >
            一键填入评审账号
          </Button>
        </div>
      </div>
    </section>
  );
}
