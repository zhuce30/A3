import { describe, expect, it, vi } from 'vitest';
import {
  bindRemoteAudioSpeakingState,
  createRemoteAudioSpeakingController,
} from '@/components/a3/features/coaching/use-realtime-coaching';

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

  it('stops the active remote audio and removes listeners when the owner unmounts', async () => {
    const audio = new FakeRemoteAudio();
    const onSpeakingChange = vi.fn();
    const controller = createRemoteAudioSpeakingController(onSpeakingChange);

    controller.attach(audio);
    audio.dispatchEvent(new Event('playing'));
    expect(onSpeakingChange).toHaveBeenLastCalledWith(true);

    controller.dispose();
    audio.dispatchEvent(new Event('playing'));
    await Promise.resolve();

    expect(audio.pause).toHaveBeenCalledOnce();
    expect(audio.srcObject).toBeNull();
    expect(audio.remove).toHaveBeenCalledOnce();
    expect(onSpeakingChange).toHaveBeenLastCalledWith(false);
    expect(onSpeakingChange).toHaveBeenCalledTimes(2);
  });

  it('ignores an old play rejection after a newer track starts playing', async () => {
    const oldPlayback = deferred<void>();
    const oldAudio = new FakeRemoteAudio(oldPlayback.promise);
    const newAudio = new FakeRemoteAudio(Promise.resolve());
    const onSpeakingChange = vi.fn();
    const controller = createRemoteAudioSpeakingController(onSpeakingChange);

    controller.attach(oldAudio);
    controller.attach(newAudio);
    newAudio.dispatchEvent(new Event('playing'));
    oldPlayback.reject(new Error('old autoplay rejection'));
    await Promise.resolve();
    await Promise.resolve();

    expect(onSpeakingChange).toHaveBeenLastCalledWith(true);
    controller.dispose();
  });
});

class FakeRemoteAudio extends EventTarget {
  autoplay = false;
  srcObject: MediaProvider | null = {} as MediaStream;
  play = vi.fn<() => Promise<void>>();
  pause = vi.fn();
  remove = vi.fn();

  constructor(playback: Promise<void> = Promise.resolve()) {
    super();
    this.play.mockImplementation(() => playback);
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
