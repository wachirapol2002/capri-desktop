// Her voice, out loud: her lines and her chat's answers. The audio comes from the main process
// (speech.js there: Windows' own voices or a speech service) and plays through her sounds' output
// (voice.js), so her volume and mute apply to it too. A new line cuts off the one before, and
// while she speaks her blips keep quiet.

const MAX = 600;

export class Speech {
  constructor({ host, voice }) {
    this.host = host;
    this.voice = voice;       // her sounds (voice.js): its output, volume and mute
    this.provider = 'off';    // config.speech.provider
    this.name = '';           // a Windows voice's name, or the service's voice
    this.lang = 'en';
    this.speaking = false;
    this.source = null;       // the service's audio playing
    this.turn = 0;            // bumped by every new line: an older one arriving late is dropped
    this.last = { text: '', at: 0 };
  }

  configure(cfg) {
    const s = cfg.speech || {};
    this.provider = s.provider || 'off';
    this.name = s.voice || '';
    this.lang = cfg.lang || 'en';
    if (!this.on) this.stop();
  }

  get on() {
    return this.provider !== 'off' && !this.voice.muted;
  }

  say(text) {
    const line = clean(text);
    if (!this.on || !line) return;
    const now = performance.now();
    if (line === this.last.text && now - this.last.at < 4000) return; // the same panel shown again
    this.last = { text: line, at: now };
    this.stop();
    this.service(line, this.turn);
  }

  async service(line, turn) {
    const res = await this.host.speak(line).catch((err) => ({ error: err.message }));
    if (turn !== this.turn) return;
    if (!res?.audio) {
      if (res?.error) console.warn('[capri] her voice:', res.error);
      return;
    }
    const ctx = this.voice.ensure();
    if (ctx.state === 'suspended') await ctx.resume();
    if (turn !== this.turn) return;
    // an <audio> element (through her sounds' output): it plays faster without her sounding higher
    const url = URL.createObjectURL(new Blob([res.audio]));
    const el = new Audio(url);
    el.preservesPitch = true;
    el.playbackRate = res.rate || 1;
    const node = ctx.createMediaElementSource(el);
    node.connect(this.voice.master);
    const over = () => {
      node.disconnect();
      URL.revokeObjectURL(url);
      if (this.source !== el) return;
      this.source = null;
      this.speaking = false;
    };
    el.onended = el.onerror = over;
    this.source = el;
    this.speaking = true;
    el.play().catch(over);
  }

  stop() {
    this.turn++;
    if (this.source) {
      this.source.pause();
      this.source.onended?.(); // lets go of it
    }
    this.source = null;
    this.speaking = false;
  }
}

// What to say out loud: her words only (no tags, code, links or emoji)
function clean(text) {
  return String(text || '')
    .replace(/\[\[[^\]]*\]\]/g, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[*_#>~|]+/g, ' ')
    .replace(/\p{Extended_Pictographic}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX);
}
