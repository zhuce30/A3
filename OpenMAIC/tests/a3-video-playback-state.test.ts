import { describe, expect, it } from 'vitest';

import { getVideoPlaybackState } from '@/lib/a3/video-playback';


describe('A3 video playback state', () => {
  it('keeps authenticated A3 playback URLs available', () => {
    expect(getVideoPlaybackState('/api/a3/resources/video-playback/8d572da0-ec77-43c7-b6f4-578860b7cabc')).toBe('available');
  });

  it('detects expired Seedance signed URLs', () => {
    const url = 'https://provider.invalid/video.mp4?X-Tos-Date=20260718T160102Z&X-Tos-Expires=86400&X-Tos-Signature=secret';
    expect(getVideoPlaybackState(url, undefined, new Date('2026-07-22T00:00:00Z'))).toBe('expired');
  });

  it('treats old external artifacts without parseable expiry metadata as expired', () => {
    expect(
      getVideoPlaybackState(
        'https://provider.invalid/video.mp4?opaque=1',
        '2026-07-18T00:00:00Z',
        new Date('2026-07-22T00:00:00Z'),
      ),
    ).toBe('expired');
  });

  it('allows recent external URLs while migration is in progress', () => {
    expect(
      getVideoPlaybackState(
        'https://provider.invalid/video.mp4?opaque=1',
        '2026-07-21T18:00:00Z',
        new Date('2026-07-22T00:00:00Z'),
      ),
    ).toBe('remote');
  });
});
