// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

export function isWgpuReplaySnapshotEmpty(snapshot) {
  return snapshot.backlog === 0 &&
    snapshot.readIndex === snapshot.publishedReadIndex &&
    snapshot.stagedUploads === 0 &&
    !snapshot.heldReplay &&
    snapshot.pendingMappedUploads === 0 &&
    snapshot.activeMappedBatches === 0 &&
    snapshot.pendingRemaps === 0 &&
    !snapshot.capacityBlocked &&
    !snapshot.mappedDrainTimerPending &&
    !snapshot.loadFenceActive &&
    !snapshot.fatal;
}

export function requireWgpuReplayRing(snapshot, required) {
  if (required && !snapshot.registered) {
    throw new Error("WGPU replay finalization requires a registered command ring");
  }
}

export function createWgpuReplayStabilityTracker({
  minimumObservations = 2,
  minimumStableMs = 50,
} = {}) {
  let stableWriteIndex = null;
  let stableEmptyObservations = 0;
  let stableSinceMs = null;

  return {
    observe(snapshot, observedAtMs) {
      if (!isWgpuReplaySnapshotEmpty(snapshot)) {
        stableWriteIndex = null;
        stableEmptyObservations = 0;
        stableSinceMs = null;
      } else if (stableWriteIndex === snapshot.writeIndex) {
        stableEmptyObservations += 1;
      } else {
        stableWriteIndex = snapshot.writeIndex;
        stableEmptyObservations = 1;
        stableSinceMs = observedAtMs;
      }
      const stableEmptyMs = stableSinceMs === null
        ? 0
        : observedAtMs - stableSinceMs;
      return {
        ready: stableEmptyObservations >= minimumObservations &&
          stableEmptyMs >= minimumStableMs,
        stableWriteIndex,
        stableEmptyObservations,
        stableEmptyMs,
      };
    },
  };
}

export async function awaitWgpuQueueCompletion(
  queue,
  {
    required = false,
    deadlineAtMs,
    now = () => globalThis.performance.now(),
    setTimeoutFn = globalThis.setTimeout,
    clearTimeoutFn = globalThis.clearTimeout,
  } = {}
) {
  if (required && typeof queue?.onSubmittedWorkDone !== "function") {
    throw new Error("WGPU replay finalization requires GPU completion support");
  }
  const startedAtMs = now();
  if (typeof queue?.onSubmittedWorkDone !== "function") {
    return { required, completed: false, elapsedMs: now() - startedAtMs };
  }
  const remainingMs = deadlineAtMs - startedAtMs;
  if (remainingMs <= 0) throw new Error("WGPU replay GPU completion timed out");
  let timeoutHandle;
  try {
    await Promise.race([
      Promise.resolve(queue.onSubmittedWorkDone()),
      new Promise((_, reject) => {
        timeoutHandle = setTimeoutFn(
          () => reject(new Error("WGPU replay GPU completion timed out")),
          remainingMs
        );
      }),
    ]);
  } finally {
    clearTimeoutFn(timeoutHandle);
  }
  return {
    required,
    completed: true,
    elapsedMs: now() - startedAtMs,
  };
}

export function validatePostCompletionReplaySnapshot(snapshot, stableWriteIndex) {
  if (
    !isWgpuReplaySnapshotEmpty(snapshot) ||
    snapshot.writeIndex !== stableWriteIndex
  ) {
    throw new Error(
      `WGPU replay changed during GPU completion: ${JSON.stringify(snapshot)}`
    );
  }
}
