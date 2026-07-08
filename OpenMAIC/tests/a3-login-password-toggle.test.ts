import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const authPagesPath = path.resolve(process.cwd(), 'components/a3/auth/a3-auth-pages.tsx');

describe('A3 login password visibility', () => {
  it('lets students toggle the login password input visibility', () => {
    const source = fs.readFileSync(authPagesPath, 'utf8');
    const loginSection = source.slice(source.indexOf('export function LoginPage'), source.indexOf('export function RegisterPage'));

    expect(source).toContain('Eye,');
    expect(source).toContain('EyeOff,');
    expect(loginSection).toContain("const [showPassword, setShowPassword] = useState(false);");
    expect(loginSection).toContain("type={showPassword ? 'text' : 'password'}");
    expect(loginSection).toContain("aria-label={showPassword ? '隐藏密码' : '显示密码'}");
    expect(loginSection).toContain('setShowPassword((current) => !current)');
  });

  it('offers demo account fill actions and a concrete learning preview', () => {
    const source = fs.readFileSync(authPagesPath, 'utf8');
    const loginSection = source.slice(source.indexOf('export function LoginPage'), source.indexOf('export function RegisterPage'));

    expect(loginSection).toContain('fillDemoAccount');
    expect(loginSection).toContain("setIdentifier('13800000001')");
    expect(loginSection).toContain("setIdentifier('13800000002')");
    expect(loginSection).toContain("setPassword('Demo@123456')");
    expect(loginSection).toContain('data-testid="a3-login-demo-student"');
    expect(loginSection).toContain('data-testid="a3-login-demo-teacher"');
    expect(source).toContain('data-testid="a3-login-learning-preview"');
    expect(source).toContain('今日学习预览');
    expect(source).toContain('AI 课堂');
  });
});
