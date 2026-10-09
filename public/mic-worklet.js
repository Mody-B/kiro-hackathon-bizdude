// AudioWorklet: downsample the mic (44.1/48kHz) to 16kHz, convert to 16-bit
// PCM, and post ~100ms chunks as ArrayBuffers to the main thread.

class PCM16kProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.targetRate = 16000;
    // sampleRate is a global in the AudioWorklet scope (input rate).
    this.ratio = sampleRate / this.targetRate;
    this._acc = []; // accumulated 16kHz samples (Float32) before chunking
    this.chunkSamples = Math.round(this.targetRate * 0.1); // 100ms @ 16kHz
    this._pos = 0; // fractional read position for simple decimation
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channel = input[0];
    if (!channel) return true;

    // Average down to 16kHz by picking samples with a running fractional step.
    for (let i = 0; i < channel.length; i++) {
      this._pos += 1;
      if (this._pos >= this.ratio) {
        this._pos -= this.ratio;
        this._acc.push(channel[i]);
      }
    }

    // Emit full 100ms chunks.
    while (this._acc.length >= this.chunkSamples) {
      const slice = this._acc.splice(0, this.chunkSamples);
      const pcm = new Int16Array(slice.length);
      for (let i = 0; i < slice.length; i++) {
        let s = Math.max(-1, Math.min(1, slice[i]));
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      this.port.postMessage(pcm.buffer, [pcm.buffer]);
    }

    return true;
  }
}

registerProcessor("pcm-16k", PCM16kProcessor);
