export const FRESH_FRAME_DELIVERY = Object.freeze({
  IMMEDIATE: "immediate",
  QUEUED: "queued",
});

export function legacyTickQueueRequested(search = "") {
  return new URLSearchParams(search).get("legacytickqueue") === "1";
}

export function freshFrameDeliveryForPacing(pacingMode, legacyTickQueue = false) {
  if (pacingMode === "smooth" || (pacingMode === "tick" && legacyTickQueue)) {
    return FRESH_FRAME_DELIVERY.QUEUED;
  }
  return FRESH_FRAME_DELIVERY.IMMEDIATE;
}
