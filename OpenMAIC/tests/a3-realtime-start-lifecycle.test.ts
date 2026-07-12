import { describe, expect, it, vi } from 'vitest';
import {
  acquireRealtimeStartResource,
  canStartRealtimeCall,
  createRealtimeStartOperationController,
  runRealtimeEndLifecycle,
  runRealtimeStartStep,
} from '@/components/a3/features/coaching/use-realtime-coaching';

describe('A3 realtime start lifecycle', () => {
  it('invalidates a connecting operation when the call ends', async () => {
    const controller = createRealtimeStartOperationController();
    const operation = controller.begin();
    const pending = deferred<string>();
    const task = runRealtimeStartStep(operation, controller.isCurrent, () => pending.promise);
    controller.invalidate();
    pending.resolve('late session');

    await expect(task).resolves.toEqual({ committed: false });
  });

  it('stops a media stream obtained after stop or unmount', async () => {
    const controller = createRealtimeStartOperationController();
    const operation = controller.begin();
    const pending = deferred<FakeStream>();
    const stream = new FakeStream();

    const task = acquireRealtimeStartResource(
      operation,
      controller.isCurrent,
      () => pending.promise,
      (lateStream) => lateStream.getTracks().forEach((track) => track.stop()),
    );
    controller.invalidate();
    pending.resolve(stream);

    await expect(task).resolves.toBeNull();
    expect(stream.track.stop).toHaveBeenCalledOnce();
  });

  it('surfaces a session request rejection only for the current operation', async () => {
    const controller = createRealtimeStartOperationController();
    const operation = controller.begin();
    const onError = vi.fn();

    await expect(runRealtimeStartStep(
      operation,
      controller.isCurrent,
      async () => {
        throw new Error('network down');
      },
      onError,
    )).resolves.toEqual({ committed: false });

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'network down' }));
  });

  it('stops media before waiting for transcript persistence', async () => {
    const controller = createRealtimeStartOperationController();
    const operation = controller.begin();
    const persistence = deferred<void>();
    const stopMedia = vi.fn();

    const task = runRealtimeEndLifecycle({
      operation,
      isCurrent: controller.isCurrent,
      stopMedia,
      persist: () => persistence.promise,
      requestEnd: async () => 'summary',
      commit: vi.fn(),
    });

    expect(stopMedia).toHaveBeenCalledOnce();
    persistence.resolve();
    await task;
  });

  it('does not let an old end request affect a newer start operation', async () => {
    const controller = createRealtimeStartOperationController();
    const operation = controller.begin();
    const persistence = deferred<void>();
    const requestEnd = vi.fn(async () => 'old summary');
    const commit = vi.fn();

    const task = runRealtimeEndLifecycle({
      operation,
      isCurrent: controller.isCurrent,
      stopMedia: vi.fn(),
      persist: () => persistence.promise,
      requestEnd,
      commit,
    });
    controller.begin();
    persistence.resolve();
    await task;

    expect(requestEnd).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });

  it('does not allow starting another call while a summary is ending', () => {
    expect(canStartRealtimeCall('ending')).toBe(false);
    expect(canStartRealtimeCall('ended')).toBe(true);
  });
});

class FakeStream {
  track = { stop: vi.fn() };

  getTracks() {
    return [this.track];
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
