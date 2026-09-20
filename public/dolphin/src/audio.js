import {
  createAudioPcmRing,
  snapshotAudioPcmRing,
} from "./audio-pcm-ring.js";

export class AudioController {
  constructor() {
    this.context = null;
    this.gain = null;
    this.source = null;
    this.muted = true;
    // 0..1, driven by the volume dial. Mute is kept separate so the dial
    // position survives a mute/unmute round trip.
    this.volume = 1;
    this.available = false;
    this.pumpTimer = 0;
    this.pumpPending = false;
    this.nextPlayTime = 0;
    // §28cm/cu audio buffer tuning. 120ms holds clean once the CPU
    // throttle uses sleep_until (§28cr3 reverted busy-spin → audio thread
    // gets CPU during throttle waits → no starvation). 80ms is too tight
    // (probe showed 5u/4d at 80ms). 120ms is the sweet spot for audio
    // latency vs robustness. URL param ?audiolead=N (seconds, 0.05-1.0)
    // overrides. ?audiopump=N (ms, 5-100) tunes pump interval.
    const params = new URLSearchParams(window.location.search);
    this.requestedTransport = params.get("audiotransport") === "worklet" ? "worklet" : "legacy";
    this.activeTransport = "legacy";
    this.transportFallbackReason = this.requestedTransport === "worklet" ? "not-initialized" : "";
    this.workletRing = null;
    this.workletNode = null;
    this.transportBridge = null;
    const leadParam = Number.parseFloat(params.get("audiolead") || "");
    this.targetLeadSeconds =
      Number.isFinite(leadParam) && leadParam >= 0.05 && leadParam <= 1
        ? leadParam
        : 0.12;
    this.startLeadSeconds = 0.05;
    this.chunkFrames = 1024;
    const pumpParam = Number.parseInt(params.get("audiopump") || "", 10);
    this.pumpIntervalMs =
      Number.isFinite(pumpParam) && pumpParam >= 5 && pumpParam <= 100
        ? pumpParam
        : 15;
    this.stats = "audio:off";

    // §28cx main-thread contention diagnostics. The pump is driven by a
    // setInterval on the main thread; when the main thread is blocked the
    // interval is starved and the AudioContext schedule runs dry → underrun.
    // These counters (a few numbers per pump call — negligible cost) let the
    // main-thread profiler (?mainprof=1) distinguish "setInterval starved on
    // main thread" (large pump gaps) from "worker slow to answer mixAudio"
    // (large mix latency). Read via window.__audio.profile.
    this.lastPumpAt = 0;
    this.profile = {
      pumpCount: 0,
      pumpMisses: 0,
      maxGapMs: 0,
      sumGapMs: 0,
      gapSamples: 0,
      lastGapMs: 0,
      maxMixMs: 0,
      sumMixMs: 0,
      mixSamples: 0,
      pumpPendingSkipCount: 0,
      underrunCount: 0,
      overrunCount: 0,
      scheduleLeadSeconds: 0,
      scheduleDriftSeconds: 0
    };
  }

  setTransportBridge(bridge) {
    this.transportBridge = typeof bridge === "function" ? bridge : null;
  }

  setSource(source) {
    this.source = typeof source === "function" ? source : null;
    this.available = Boolean(this.source);
    this.stats = this.source ? "audio:ready" : "audio:off";
    if (!this.muted) {
      this.startPump();
      void this.pump();
    }
  }

  async setMuted(muted) {
    this.muted = Boolean(muted);
    if (!muted) {
      await this.ensureContext();
      if (this.activeTransport === "worklet") {
        await this.transportBridge?.({ enabled: true, muted: false, sab: this.workletRing.sab });
      } else {
        this.startPump();
        await this.pump();
      }
    } else {
      this.stopPump();
      if (this.activeTransport === "worklet") {
        await this.transportBridge?.({ enabled: true, muted: true, sab: this.workletRing.sab });
      }
    }
    this.update();
    return !this.muted && this.available;
  }

  async ensureContext() {
    if (this.context) {
      if (this.context.state === "suspended") {
        await this.context.resume();
      }
      return;
    }

    const AudioContext = window.AudioContext ?? window.webkitAudioContext;
    if (!AudioContext) {
      return;
    }

    if (this.requestedTransport === "worklet") {
      try {
        this.context = new AudioContext({ sampleRate: 48000 });
      } catch {
        this.context = new AudioContext();
      }
    } else {
      this.context = new AudioContext();
    }
    this.gain = this.context.createGain();
    this.gain.gain.value = this.muted ? 0 : this.volume;
    this.gain.connect(this.context.destination);
    if (this.requestedTransport === "worklet") {
      await this.tryEnableWorkletTransport();
    }
  }

  async tryEnableWorkletTransport() {
    const fail = (reason) => {
      this.activeTransport = "legacy";
      this.transportFallbackReason = reason;
      this.stats = `audio:legacy-fallback:${reason}`;
      return false;
    };
    if (globalThis.crossOriginIsolated !== true || typeof SharedArrayBuffer !== "function") {
      return fail("cross-origin-isolation-required");
    }
    if (!this.context?.audioWorklet || typeof globalThis.AudioWorkletNode !== "function") {
      return fail("audio-worklet-unavailable");
    }
    if (this.context.sampleRate !== 48000) return fail(`sample-rate-${this.context.sampleRate}`);
    if (!this.transportBridge) return fail("producer-bridge-unavailable");
    try {
      this.workletRing = createAudioPcmRing();
      await this.context.audioWorklet.addModule(
        new URL("./audio-worklet-processor.js", import.meta.url).href
      );
      const node = new AudioWorkletNode(this.context, "dolphin-pcm", {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        processorOptions: { sab: this.workletRing.sab },
      });
      node.connect(this.gain);
      this.workletNode = node;
      const activation = await this.transportBridge({
        enabled: true,
        muted: this.muted,
        sab: this.workletRing.sab,
      });
      const activated = typeof activation === "object" ? activation?.active : activation;
      if (!activated) {
        const reason = typeof activation === "object" ? activation?.reason : "";
        throw new Error(`producer-rejected${reason ? `:${reason}` : ""}`);
      }
      node.onprocessorerror = () => void this.fallbackFromWorklet("processor-error");
      this.activeTransport = "worklet";
      this.transportFallbackReason = "";
      this.stats = "audio:worklet-ready";
      this.stopPump();
      return true;
    } catch (error) {
      this.workletNode?.disconnect?.();
      this.workletNode = null;
      this.workletRing = null;
      return fail(`worklet-init:${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async fallbackFromWorklet(reason) {
    this.workletNode?.disconnect?.();
    this.workletNode = null;
    await this.transportBridge?.({ enabled: false, muted: this.muted, sab: null });
    this.activeTransport = "legacy";
    this.transportFallbackReason = reason;
    this.stats = `audio:legacy-fallback:${reason}`;
    if (!this.muted) {
      this.startPump();
      await this.pump();
    }
  }

  update() {
    if (!this.context || !this.gain) {
      return;
    }

    const now = this.context.currentTime;
    this.gain.gain.setTargetAtTime(this.muted ? 0 : this.volume, now, 0.01);
  }

  startPump() {
    if (this.pumpTimer || this.muted || !this.source) {
      return;
    }

    this.pumpTimer = window.setInterval(() => {
      void this.pump();
    }, this.pumpIntervalMs);
  }

  stopPump() {
    if (!this.pumpTimer) {
      return;
    }

    window.clearInterval(this.pumpTimer);
    this.pumpTimer = 0;
  }

  async pump() {
    // Record cadence BEFORE the early-return guards so we capture every
    // setInterval firing — including the ticks that no-op because a prior
    // pump is still pending. A gap ≫ pumpIntervalMs means the main thread
    // starved this timer (the underrun smoking gun).
    const pumpEnteredAt = performance.now();
    if (this.lastPumpAt) {
      const gap = pumpEnteredAt - this.lastPumpAt;
      const p = this.profile;
      p.lastGapMs = gap;
      p.sumGapMs += gap;
      p.gapSamples += 1;
      if (gap > p.maxGapMs) p.maxGapMs = gap;
      if (gap > this.pumpIntervalMs * 2) p.pumpMisses += 1;
    }
    this.lastPumpAt = pumpEnteredAt;
    this.profile.pumpCount += 1;

    if (this.pumpPending) {
      this.profile.pumpPendingSkipCount += 1;
      return;
    }
    if (this.muted || !this.source || !this.context || !this.gain) {
      return;
    }

    this.pumpPending = true;
    try {
      if (this.context.state === "suspended") {
        await this.context.resume();
      }

      const now = this.context.currentTime;
      const leadBeforeFill = this.nextPlayTime - now;
      if (this.nextPlayTime > 0 && leadBeforeFill < 0) this.profile.underrunCount += 1;
      if (leadBeforeFill > this.targetLeadSeconds + this.chunkFrames / 48000) {
        this.profile.overrunCount += 1;
      }
      if (this.nextPlayTime < now + this.startLeadSeconds) {
        this.nextPlayTime = now + this.startLeadSeconds;
      }

      let scheduled = 0;
      const horizon = now + this.targetLeadSeconds;
      while (!this.muted && this.nextPlayTime < horizon && scheduled < 6) {
        // mixAudio is a postMessage round-trip to the worker; time it so the
        // profiler can attribute slow chunks to a busy worker vs. main-thread
        // starvation (which shows up as pump-gap, recorded above).
        const mixT0 = performance.now();
        const chunk = await this.source(this.chunkFrames);
        const mixMs = performance.now() - mixT0;
        const p = this.profile;
        p.sumMixMs += mixMs;
        p.mixSamples += 1;
        if (mixMs > p.maxMixMs) p.maxMixMs = mixMs;
        if (!this.scheduleChunk(chunk)) {
          break;
        }
        scheduled += 1;
      }
    } catch (error) {
      this.available = false;
      this.stats = error instanceof Error ? error.message : String(error);
    } finally {
      this.pumpPending = false;
    }
  }

  scheduleChunk(chunk) {
    if (!chunk?.available || !chunk.samples || !this.context || !this.gain) {
      this.available = false;
      this.stats = chunk?.stats || "audio:unavailable";
      return false;
    }

    const channels = Math.min(2, Math.max(1, Number(chunk.channels) || 2));
    const sampleRate = Math.max(8000, Number(chunk.sampleRate) || this.context.sampleRate || 48000);
    const frames = Math.max(0, Math.min(Number(chunk.frames) || 0, this.chunkFrames * 4));
    const samples = chunk.samples instanceof Int16Array ? chunk.samples : new Int16Array(chunk.samples);
    const usableFrames = Math.min(frames, Math.floor(samples.length / channels));
    if (usableFrames <= 0) {
      this.available = Boolean(chunk.available);
      this.stats = chunk.stats || "audio:empty";
      return false;
    }

    const buffer = this.context.createBuffer(channels, usableFrames, sampleRate);
    for (let channel = 0; channel < channels; channel += 1) {
      const output = buffer.getChannelData(channel);
      for (let frame = 0; frame < usableFrames; frame += 1) {
        output[frame] = samples[frame * channels + channel] / 32768;
      }
    }

    const node = this.context.createBufferSource();
    node.buffer = buffer;
    node.connect(this.gain);
    const startAt = Math.max(this.context.currentTime + this.startLeadSeconds, this.nextPlayTime);
    node.start(startAt);
    this.nextPlayTime = startAt + usableFrames / sampleRate;
    this.profile.scheduleLeadSeconds = this.nextPlayTime - this.context.currentTime;
    this.profile.scheduleDriftSeconds = this.profile.scheduleLeadSeconds - this.targetLeadSeconds;
    this.available = true;
    this.stats = chunk.stats || `audio:frames:${usableFrames}`;
    return true;
  }

  setVolume(value) {
    const next = Math.min(1, Math.max(0, Number(value) || 0));
    this.volume = next;
    // Turning the dial up from silence implies wanting sound.
    if (next > 0 && this.muted) this.muted = false;
    if (next === 0) this.muted = true;
    this.update();
    return this.volume;
  }

  label() {
    return this.available ? (this.muted ? "Muted" : "Audio") : "Audio off";
  }

  causalTelemetry() {
    const p = this.profile;
    const workletRing = this.workletRing ? snapshotAudioPcmRing(this.workletRing) : null;
    return {
      requestedTransport: this.requestedTransport,
      activeTransport: this.activeTransport,
      transportFallbackReason: this.transportFallbackReason,
      workletRing,
      pumpCount: p.pumpCount,
      pumpPendingSkipCount: p.pumpPendingSkipCount,
      pumpMissCount: p.pumpMisses,
      pumpGapLastMs: p.lastGapMs,
      pumpGapAverageMs: p.gapSamples > 0 ? p.sumGapMs / p.gapSamples : 0,
      pumpGapMaxMs: p.maxGapMs,
      mixRoundTripAverageMs: p.mixSamples > 0 ? p.sumMixMs / p.mixSamples : 0,
      mixRoundTripMaxMs: p.maxMixMs,
      underrunCount: this.activeTransport === "worklet"
        ? workletRing?.underrunEvents || 0
        : p.underrunCount,
      overrunCount: p.overrunCount,
      scheduleLeadSeconds: p.scheduleLeadSeconds,
      scheduleDriftSeconds: p.scheduleDriftSeconds
    };
  }
}
