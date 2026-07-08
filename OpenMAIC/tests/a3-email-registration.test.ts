import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const authPagesPath = path.resolve(process.cwd(), 'components/a3/auth/a3-auth-pages.tsx');

describe('A3 email registration', () => {
  it('uses email as the registration verification target instead of phone', () => {
    const source = fs.readFileSync(authPagesPath, 'utf8');

    const registerSection = source.slice(source.indexOf('export function RegisterPage'), source.indexOf('export function ForgotPasswordPage'));
    expect(registerSection).toContain("const [email, setEmail] = useState('')");
    expect(registerSection).toContain("postJson('/api/auth/register/', { role: 'student', displayName, email, code, password, confirmPassword, school })");
    expect(registerSection).toContain('verification.sendCode(email)');
    expect(registerSection).not.toContain('verification.sendCode(phone)');
  });
});
