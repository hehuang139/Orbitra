export const AUDIO_PCM_HEADER_BYTES = 256;
export const AUDIO_PCM_CAPACITY_FRAMES = 8192;
export const AUDIO_PCM_CHANNELS = 2;
export const AUDIO_PCM_SAMPLE_RATE = 48000;

export const AUDIO_PCM_STATE_STOPPED = 0;
export const AUDIO_PCM_STATE_PREFILL = 1;
export const AUDIO_PCM_STATE_RUNNING = 2;
export const AUDIO_PCM_STATE_MUTED = 3;

export const AUDIO_PCM_HEADER = Object.freeze({
  WRITE_INDEX: 0,
  READ_INDEX: 1,
  CAPACITY_FRAMES: 2,
  CHANNELS: 3,
  SAMPLE_RATE: 4,
  STATE: 5,
  EPOCH: 6,
  EPOCH_ACK: 7,
  UNDERRUN_FRAMES: 8,
  UNDERRUN_EVENTS: 9,
  WRITTEN_FRAMES: 10,
  CONSUMED_FRAMES: 11,
  PRODUCER_REFILLS: 12,
  PRODUCER_EMPTY_MIXES: 13,
  PRODUCER_TIMER_GAP_MAX_US: 14,
  PRODUCER_FILL_HIGH_WATER: 15,
});

const HEADER_WORDS = AUDIO_PCM_HEADER_BYTES / Int32Array.BYTES_PER_ELEMENT;

export function audioPcmRingByteLength(capacityFrames = AUDIO_PCM_CAPACITY_FRAMES) {
  return AUDIO_PCM_HEADER_BYTES + capacityFrames * AUDIO_PCM_CHANNELS * Int16Array.BYTES_PER_ELEMENT;
}

export function createAudioPcmRing(capacityFrames = AUDIO_PCM_CAPACITY_FRAMES) {
  if (!Number.isInteger(capacityFrames) || capacityFrames <= 0) {
    throw new RangeError("audio PCM capacity must be a positive integer");
  }
  const sab = new SharedArrayBuffer(audioPcmRingByteLength(capacityFrames));
  const ring = openAudioPcmRing(sab);
  Atomics.store(ring.header, AUDIO_PCM_HEADER.CAPACITY_FRAMES, capacityFrames);
  Atomics.store(ring.header, AUDIO_PCM_HEADER.CHANNELS, AUDIO_PCM_CHANNELS);
  Atomics.store(ring.header, AUDIO_PCM_HEADER.SAMPLE_RATE, AUDIO_PCM_SAMPLE_RATE);
  Atomics.store(ring.header, AUDIO_PCM_HEADER.STATE, AUDIO_PCM_STATE_MUTED);
  return ring;
}

export function openAudioPcmRing(sab) {
  if (!(sab instanceof SharedArrayBuffer) || sab.byteLength < AUDIO_PCM_HEADER_BYTES) {
    throw new TypeError("audio PCM ring requires a SharedArrayBuffer with a 256-byte header");
  }
  const sampleBytes = sab.byteLength - AUDIO_PCM_HEADER_BYTES;
  if (sampleBytes % (AUDIO_PCM_CHANNELS * Int16Array.BYTES_PER_ELEMENT) !== 0) {
    throw new RangeError("audio PCM payload must contain complete stereo Int16 frames");
  }
  return {
    sab,
    header: new Int32Array(sab, 0, HEADER_WORDS),
    samples: new Int16Array(sab, AUDIO_PCM_HEADER_BYTES),
  };
}

export function validateAudioPcmRing(ring) {
  const capacity = Atomics.load(ring.header, AUDIO_PCM_HEADER.CAPACITY_FRAMES) >>> 0;
  const channels = Atomics.load(ring.header, AUDIO_PCM_HEADER.CHANNELS) >>> 0;
  const sampleRate = Atomics.load(ring.header, AUDIO_PCM_HEADER.SAMPLE_RATE) >>> 0;
  if (capacity !== AUDIO_PCM_CAPACITY_FRAMES || ring.samples.length !== capacity * AUDIO_PCM_CHANNELS) {
    throw new RangeError("audio PCM ring capacity does not match its SAB payload");
  }
  if (channels !== AUDIO_PCM_CHANNELS || sampleRate !== AUDIO_PCM_SAMPLE_RATE) {
    throw new RangeError("audio PCM ring format must be stereo Int16 at 48 kHz");
  }
  return ring;
}

export function audioPcmAvailableFrames(header) {
  return (Atomics.load(header, AUDIO_PCM_HEADER.WRITE_INDEX) -
    Atomics.load(header, AUDIO_PCM_HEADER.READ_INDEX)) >>> 0;
}

export function audioPcmFreeFrames(header) {
  const capacity = Atomics.load(header, AUDIO_PCM_HEADER.CAPACITY_FRAMES) >>> 0;
  return Math.max(0, capacity - Math.min(capacity, audioPcmAvailableFrames(header)));
}

export function writeAudioPcm(ring, source, frames, channels = AUDIO_PCM_CHANNELS) {
  const { header, samples } = ring;
  const capacity = Atomics.load(header, AUDIO_PCM_HEADER.CAPACITY_FRAMES) >>> 0;
  const requested = Math.max(0, Math.min(frames | 0, Math.floor(source.length / Math.max(1, channels))));
  const writable = Math.min(requested, audioPcmFreeFrames(header));
  const write = Atomics.load(header, AUDIO_PCM_HEADER.WRITE_INDEX) >>> 0;
  for (let frame = 0; frame < writable; frame += 1) {
    const dst = ((write + frame) % capacity) * AUDIO_PCM_CHANNELS;
    const src = frame * channels;
    const left = source[src] || 0;
    samples[dst] = left;
    samples[dst + 1] = channels > 1 ? (source[src + 1] || 0) : left;
  }
  if (writable > 0) {
    Atomics.add(header, AUDIO_PCM_HEADER.WRITTEN_FRAMES, writable);
    Atomics.store(header, AUDIO_PCM_HEADER.WRITE_INDEX, (write + writable) | 0);
  }
  return writable;
}

export function requestAudioPcmEpoch(ring, state = AUDIO_PCM_STATE_PREFILL) {
  Atomics.store(ring.header, AUDIO_PCM_HEADER.STATE, state);
  return Atomics.add(ring.header, AUDIO_PCM_HEADER.EPOCH, 1) + 1 >>> 0;
}

export function consumeAudioPcm(
  ring,
  outputLeft,
  outputRight,
  frames = outputLeft.length,
  result = {}
) {
  const { header, samples } = ring;
  const count = Math.max(0, Math.min(frames | 0, outputLeft.length, outputRight.length));
  const epoch = Atomics.load(header, AUDIO_PCM_HEADER.EPOCH) >>> 0;
  const ack = Atomics.load(header, AUDIO_PCM_HEADER.EPOCH_ACK) >>> 0;
  if (epoch !== ack) {
    const write = Atomics.load(header, AUDIO_PCM_HEADER.WRITE_INDEX);
    Atomics.store(header, AUDIO_PCM_HEADER.READ_INDEX, write);
    Atomics.store(header, AUDIO_PCM_HEADER.EPOCH_ACK, epoch | 0);
    outputLeft.fill(0, 0, count);
    outputRight.fill(0, 0, count);
    result.consumedFrames = 0;
    result.underrunFrames = 0;
    result.flushed = true;
    result.epoch = epoch;
    return result;
  }
  if ((Atomics.load(header, AUDIO_PCM_HEADER.STATE) | 0) !== AUDIO_PCM_STATE_RUNNING) {
    outputLeft.fill(0, 0, count);
    outputRight.fill(0, 0, count);
    result.consumedFrames = 0;
    result.underrunFrames = 0;
    result.flushed = false;
    result.epoch = epoch;
    return result;
  }

  const capacity = Atomics.load(header, AUDIO_PCM_HEADER.CAPACITY_FRAMES) >>> 0;
  const read = Atomics.load(header, AUDIO_PCM_HEADER.READ_INDEX) >>> 0;
  const available = Math.min(capacity, audioPcmAvailableFrames(header));
  const consumed = Math.min(count, available);
  for (let frame = 0; frame < consumed; frame += 1) {
    const src = ((read + frame) % capacity) * AUDIO_PCM_CHANNELS;
    outputLeft[frame] = samples[src] / 32768;
    outputRight[frame] = samples[src + 1] / 32768;
  }
  outputLeft.fill(0, consumed, count);
  outputRight.fill(0, consumed, count);
  if (consumed > 0) {
    Atomics.add(header, AUDIO_PCM_HEADER.CONSUMED_FRAMES, consumed);
    Atomics.store(header, AUDIO_PCM_HEADER.READ_INDEX, (read + consumed) | 0);
  }
  const underrun = count - consumed;
  if (underrun > 0) {
    Atomics.add(header, AUDIO_PCM_HEADER.UNDERRUN_FRAMES, underrun);
    Atomics.add(header, AUDIO_PCM_HEADER.UNDERRUN_EVENTS, 1);
  }
  result.consumedFrames = consumed;
  result.underrunFrames = underrun;
  result.flushed = false;
  result.epoch = epoch;
  return result;
}

export function snapshotAudioPcmRing(ring) {
  const { header } = ring;
  const read = Atomics.load(header, AUDIO_PCM_HEADER.READ_INDEX) >>> 0;
  const write = Atomics.load(header, AUDIO_PCM_HEADER.WRITE_INDEX) >>> 0;
  return {
    state: Atomics.load(header, AUDIO_PCM_HEADER.STATE) | 0,
    epoch: Atomics.load(header, AUDIO_PCM_HEADER.EPOCH) >>> 0,
    epochAck: Atomics.load(header, AUDIO_PCM_HEADER.EPOCH_ACK) >>> 0,
    readIndex: read,
    writeIndex: write,
    fillFrames: (write - read) >>> 0,
    underrunFrames: Atomics.load(header, AUDIO_PCM_HEADER.UNDERRUN_FRAMES) >>> 0,
    underrunEvents: Atomics.load(header, AUDIO_PCM_HEADER.UNDERRUN_EVENTS) >>> 0,
    writtenFrames: Atomics.load(header, AUDIO_PCM_HEADER.WRITTEN_FRAMES) >>> 0,
    consumedFrames: Atomics.load(header, AUDIO_PCM_HEADER.CONSUMED_FRAMES) >>> 0,
    producerRefills: Atomics.load(header, AUDIO_PCM_HEADER.PRODUCER_REFILLS) >>> 0,
    producerEmptyMixes: Atomics.load(header, AUDIO_PCM_HEADER.PRODUCER_EMPTY_MIXES) >>> 0,
    producerTimerGapMaxMs:
      (Atomics.load(header, AUDIO_PCM_HEADER.PRODUCER_TIMER_GAP_MAX_US) >>> 0) / 1000,
    producerFillHighWater: Atomics.load(header, AUDIO_PCM_HEADER.PRODUCER_FILL_HIGH_WATER) >>> 0,
  };
}
