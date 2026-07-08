'use client';

import { useCallback, useEffect, useState } from 'react';
import { a3PostJson } from '@/lib/a3/api-client';

type VerificationPurpose = 'register' | 'reset' | 'bind';

type SendCodeResult = {
  success: boolean;
  error?: string;
  devCode?: string;
  retryAfter?: number;
};

export function useVerificationCode(purpose: VerificationPurpose) {
  const [cooldown, setCooldown] = useState(0);
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setInterval(() => {
      setCooldown((value) => Math.max(0, value - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [cooldown]);

  const sendCode = useCallback(async (target: string) => {
    const normalizedTarget = target.trim();
    if (!normalizedTarget) {
      setMessage('请先输入手机号或邮箱');
      return false;
    }

    setSending(true);
    setMessage('');
    const result = await a3PostJson<SendCodeResult>('/api/auth/send-code/', {
      target: normalizedTarget,
      purpose,
    });
    setSending(false);

    if (!result.success) {
      setMessage(result.error ?? '验证码发送失败');
      return false;
    }

    setCooldown(result.retryAfter ?? 60);
    setMessage(result.devCode ? `开发验证码：${result.devCode}` : '验证码已发送，请注意查收');
    return true;
  }, [purpose]);

  return {
    cooldown,
    message,
    sending,
    sendCode,
    buttonLabel: sending ? '发送中...' : cooldown > 0 ? `${cooldown} 秒后重试` : '获取验证码',
  };
}
