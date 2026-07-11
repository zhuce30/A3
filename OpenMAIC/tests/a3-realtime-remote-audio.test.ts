import { describe, expect, it, vi } from 'vitest';
import { bindRemoteAudioSpeakingState } from '@/components/a3/features/coaching/use-realtime-coaching';

describe('A3 WebRTC remote audio speaking state', () => {
  it('tracks real playback events and resets on teardown', () => {
    const audio = new EventTarget();
    const onSpeakingChange = vi.fn();
    const cleanup = bindRemoteAudioSpeakingState(
      audio as Pick<HTMLAudioElement, 'addEventListener' | 'removeEventListener'>,
      onSpeakingChange,
    );

    audio.dispatchEvent(new Event('play'));
    audio.dispatchEvent(new Event('playing'));
    audio.dispatchEvent(new Event('pause'));
    audio.dispatchEvent(new Event('play'));
    audio.dispatchEvent(new Event('ended'));
    audio.dispatchEvent(new Event('play'));
    audio.dispatchEvent(new Event('emptied'));

    expect(onSpeakingChange.mock.calls.map(([speaking]) => speaking)).toEqual([
      true,
      true,
      false,
      true,
      false,
      true,
      false,
    ]);

    cleanup();
    audio.dispatchEvent(new Event('playing'));

    expect(onSpeakingChange).toHaveBeenLastCalledWith(false);
    expect(onSpeakingChange).toHaveBeenCalledTimes(8);
  });
});
