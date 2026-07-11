import { describe, expect, it, vi } from 'vitest';

describe('A3 login submission behavior', () => {
  it('reports a readable error and always resets submitting when the request rejects', async () => {
    const authPages = await import('@/components/a3/auth/a3-auth-pages');
    const executeA3Login = (
      authPages as typeof authPages & {
        executeA3Login?: (options: {
          request: () => Promise<{ success: boolean; error?: string }>;
          onSuccess: (result: { success: boolean; error?: string }) => void;
          onError: (message: string) => void;
          onSubmittingChange: (submitting: boolean) => void;
        }) => Promise<void>;
      }
    ).executeA3Login;

    expect(executeA3Login).toBeTypeOf('function');
    if (!executeA3Login) return;

    const onSuccess = vi.fn();
    const onError = vi.fn();
    const onSubmittingChange = vi.fn();

    await executeA3Login({
      request: vi.fn().mockRejectedValue(new SyntaxError('invalid json')),
      onSuccess,
      onError,
      onSubmittingChange,
    });

    expect(onSuccess).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]?.[0]).toMatch(/登录请求失败|网络/);
    expect(onSubmittingChange.mock.calls).toEqual([[true], [false]]);
  });

  it('forwards a normal API failure and still resets submitting', async () => {
    const authPages = await import('@/components/a3/auth/a3-auth-pages');
    const executeA3Login = (
      authPages as typeof authPages & {
        executeA3Login?: (options: {
          request: () => Promise<{ success: boolean; error?: string }>;
          onSuccess: (result: { success: boolean; error?: string }) => void;
          onError: (message: string) => void;
          onSubmittingChange: (submitting: boolean) => void;
        }) => Promise<void>;
      }
    ).executeA3Login;

    expect(executeA3Login).toBeTypeOf('function');
    if (!executeA3Login) return;

    const onSuccess = vi.fn();
    const onError = vi.fn();
    const onSubmittingChange = vi.fn();

    await executeA3Login({
      request: vi.fn().mockResolvedValue({ success: false, error: '账号或密码错误' }),
      onSuccess,
      onError,
      onSubmittingChange,
    });

    expect(onSuccess).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith('账号或密码错误');
    expect(onSubmittingChange.mock.calls).toEqual([[true], [false]]);
  });
});
