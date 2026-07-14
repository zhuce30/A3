'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { useSettingsStore } from '@/lib/store/settings';

/**
 * Fetches server-configured providers on mount and merges into settings store.
 * Renders nothing — purely a side-effect component.
 */
export function ServerProvidersInit() {
  const pathname = usePathname();
  const fetchServerProviders = useSettingsStore((state) => state.fetchServerProviders);

  useEffect(() => {
    if (pathname === '/a3') return;
    fetchServerProviders();
  }, [fetchServerProviders, pathname]);

  return null;
}
