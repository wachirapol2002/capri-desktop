// Your microphone for talking out loud with her (live.js): the samples of a 16 kHz AudioContext,
// as 16-bit PCM in pieces of 100 ms, with how loud each piece is (its RMS).

const PIECE = 1600; // 100 ms at 16 kHz

class Mic extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Int16Array(PIECE);
    this.at = 0;
    this.sum = 0;
  }

  process(inputs) {
    const ch = inputs[0]?.[0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      const s = Math.max(-1, Math.min(1, ch[i]));
      this.sum += s * s;
      this.buf[this.at++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.at === PIECE) {
        const pcm = this.buf.buffer;
        this.port.postMessage({ pcm, rms: Math.sqrt(this.sum / PIECE) }, [pcm]);
        this.buf = new Int16Array(PIECE);
        this.at = 0;
        this.sum = 0;
      }
    }
    return true;
  }
}

registerProcessor('capri-mic', Mic);
