import { describe, expect, it } from 'vitest';
import {
  getA3AuthTarget,
  isA3PublicPath,
} from '@/lib/a3/auth-navigation';

describe('A3 help route access', () => {
  it('keeps the homepage and help manual public while workflows stay protected', () => {
    expect(isA3PublicPath('/a3')).toBe(true);
    expect(isA3PublicPath('/a3/help')).toBe(true);
    expect(isA3PublicPath('/a3/help/generate-personal-resources')).toBe(true);
    expect(isA3PublicPath('/a3/today')).toBe(false);
  });

  it('still sends anonymous workflow visitors through login with a safe return path', () => {
    expect(getA3AuthTarget('/a3/today', null)).toBe('/a3/login?next=%2Fa3%2Ftoday');
    expect(
      getA3AuthTarget('/a3/help/generate-personal-resources', null, {
        isPublicPath: true,
        isGuestPath: false,
        isFlowPath: false,
      }),
    ).toBeNull();
  });
});
