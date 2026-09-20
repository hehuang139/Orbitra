const DROPPABLE_TAG = /^(?:s27-|s28|webgpu-DIAG-)/;
const DROPPABLE_EXACT_TAGS = new Set([
  "webgpu-cmd-shader",
  "webgpu-pcfg",
  "webgpu-shader",
]);
const FAILURE_SIGNAL = /\b(?:err(?:or)?|fail(?:ed|ure)?|fatal|lost|rejected|throw|validation)\b/i;

function diagnosticTag(message) {
  if (typeof message !== "string") return null;
  return /^\[([^\]]+)\]/.exec(message)?.[1] ?? null;
}

export function isDroppableWgpuDiagnosticLog(message) {
  const tag = diagnosticTag(message);
  if (!tag || (!DROPPABLE_TAG.test(tag) && !DROPPABLE_EXACT_TAGS.has(tag))) return false;
  const failureCount = /\bfail=(\d+)\b/i.exec(message);
  if (failureCount && Number(failureCount[1]) !== 0) return false;
  const signalText = failureCount ? message.replace(failureCount[0], "") : message;
  return !FAILURE_SIGNAL.test(signalText);
}

export function installWgpuDiagnosticLogFilter({
  consoleObject = globalThis.console,
  enabled = false,
} = {}) {
  const droppedByTag = new Map();
  let droppedCount = 0;
  const originalLog = consoleObject?.log;
  let wrappedLog = null;

  if (enabled && typeof originalLog === "function") {
    wrappedLog = function filteredWgpuDiagnosticLog(...args) {
      if (isDroppableWgpuDiagnosticLog(args[0])) {
        const tag = diagnosticTag(args[0]) || "unknown";
        droppedCount += 1;
        droppedByTag.set(tag, (droppedByTag.get(tag) || 0) + 1);
        return;
      }
      return originalLog.apply(this, args);
    };
    consoleObject.log = wrappedLog;
  }

  return {
    restore() {
      if (wrappedLog && consoleObject.log === wrappedLog) consoleObject.log = originalLog;
    },
    snapshot() {
      return {
        schema: "wasm-dolphin.wgpu-diagnostic-log-filter.v1",
        enabled: Boolean(enabled),
        droppedCount,
        droppedByTag: Object.fromEntries(
          [...droppedByTag.entries()].sort(([left], [right]) => left.localeCompare(right))
        ),
      };
    },
  };
}
