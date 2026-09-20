import { consumeAudioPcm, openAudioPcmRing } from "./audio-pcm-ring.js";

const ProcessorBase = globalThis.AudioWorkletProcessor ?? class {};

export class DolphinPcmProcessor extends ProcessorBase {
  constructor(options = {}) {
    super(options);
    this.ring = openAudioPcmRing(options.processorOptions?.sab);
    this.consumeResult = {
      consumedFrames: 0,
      underrunFrames: 0,
      flushed: false,
      epoch: 0,
    };
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output?.[0]) return true;
    const left = output[0];
    const right = output[1] ?? output[0];
    consumeAudioPcm(this.ring, left, right, left.length, this.consumeResult);
    return true;
  }
}

if (typeof globalThis.registerProcessor === "function") {
  globalThis.registerProcessor("dolphin-pcm", DolphinPcmProcessor);
}
