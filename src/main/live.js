'use strict';

// Talking with her out loud, in real time: Gemini's Live API. Your microphone goes up as you speak
// (16 kHz PCM from the overlay), her voice comes back as she speaks (24 kHz PCM), and you can cut
// her off. The key stays in this process: the overlay only ever sees audio and words.
//
// One session at a time. Google closes a connection after a few minutes (goAway): it's picked up
// again with the handle it gave (sessionResumption), so the conversation carries on.

const WS_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const MODELS_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
// the one Google's Live API guide uses, if listing the models fails
const FALLBACK_MODEL = 'gemini-3.8-live';
// her voices there (prebuilt): the first is hers unless you pick another
const VOICES = ['Kore', 'Aoede', 'Leda', 'Zephyr', 'Puck', 'Charon', 'Fenrir', 'Orus'];
// how much of the conversation a new session is handed when her voice changes
const HANDED_TURNS = 20;

// The Live models this key can use, newest first ("gemini-3.8-live", "...native-audio..."): the ones
// for a conversation, not transcribing or translating.
async function liveModels(key) {
  const res = await fetch(`${MODELS_URL}?pageSize=1000&key=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`${res.status}`);
  const { models = [] } = await res.json();
  const version = (n) => Number(/gemini-(\d+(?:\.\d+)?)/.exec(n)?.[1] || 0);
  return models
    .filter((m) => (m.supportedGenerationMethods || []).includes('bidiGenerateContent'))
    .map((m) => m.name.replace(/^models\//, ''))
    // (Extended Thinking stops to think in the middle of a conversation: too slow to talk with)
    .filter((n) => !/transcribe|translate|tts|embed|thinking/i.test(n))
    // the latest version first; at the same version, a finished model before a preview
    .sort((a, b) => version(b) - version(a) || /preview/.test(a) - /preview/.test(b) || a.localeCompare(b));
}

let modelCache = null;
async function pickModel(key) {
  if (modelCache) return modelCache;
  const names = await liveModels(key).catch(() => []);
  // a conversation model ("live" or "native-audio") over anything else that speaks the protocol
  modelCache = names.find((n) => /live|native-audio/i.test(n)) || names[0] || FALLBACK_MODEL;
  return modelCache;
}

class LiveSession {
  // send(event): to the overlay ({ type: 'audio' | 'in' | 'out' | 'interrupted' | 'turn' | 'tool' | 'state', ... })
  constructor({ key, voice, system, tools, send }) {
    this.key = key;
    this.voice = VOICES.includes(voice) ? voice : VOICES[0];
    this.system = system;
    this.tools = tools;
    this.send = send;
    this.ws = null;
    this.handle = null;   // to pick the conversation up again on a new connection
    this.closed = false;  // ended on purpose: no picking up again
    this.model = null;
    this.said = [];       // the conversation so far, for a new session to carry on from (revoice)
  }

  async open() {
    this.model = await pickModel(this.key);
    try {
      await this.connect();
    } catch (err) {
      // an older shape of the setup message (its settings under generationConfig), if this one's refused
      if (!/unknown|invalid|cannot find field/i.test(err.message)) throw err;
      this.legacy = true;
      await this.connect();
    }
    return this.model;
  }

  // the settings, where this version of the API wants them
  setup() {
    const generation = {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: this.voice } } },
    };
    return {
      model: `models/${this.model}`,
      ...(this.legacy ? { generationConfig: generation } : generation),
      systemInstruction: { parts: [{ text: this.system }] },
      tools: this.tools.length ? [{ functionDeclarations: this.tools }] : [],
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      // no cap on how long you talk: older turns are summed up as it grows
      contextWindowCompression: { slidingWindow: {} },
      sessionResumption: this.handle ? { handle: this.handle } : {},
    };
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${WS_URL}?key=${encodeURIComponent(this.key)}`);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      let ready = false;
      ws.onopen = () => ws.send(JSON.stringify({ setup: this.setup() }));
      ws.onmessage = (e) => {
        let msg;
        try {
          msg = JSON.parse(typeof e.data === 'string' ? e.data : new TextDecoder().decode(e.data));
        } catch {
          return;
        }
        if (msg.setupComplete && !ready) {
          ready = true;
          this.send({ type: 'state', state: 'open', model: this.model });
          resolve();
          return;
        }
        this.onServer(msg);
      };
      ws.onerror = () => {}; // onclose says why
      ws.onclose = (e) => {
        if (this.ws !== ws) return;
        this.ws = null;
        const why = e.reason || `closed (${e.code})`;
        if (!ready) return reject(new Error(why));
        // Google ended this connection (its time is up): the same conversation on a new one
        if (!this.closed && this.handle) {
          this.connect().catch((err) => this.end(err.message));
          return;
        }
        this.end(this.closed ? null : why);
      };
    });
  }

  onServer(msg) {
    if (msg.sessionResumptionUpdate?.resumable && msg.sessionResumptionUpdate.newHandle) {
      this.handle = msg.sessionResumptionUpdate.newHandle;
    }
    if (msg.goAway) {
      // closing soon: on a new connection right away, before this one goes
      if (this.handle) this.reconnect().catch((err) => this.end(err.message));
      return;
    }
    if (msg.toolCall?.functionCalls?.length) {
      this.send({ type: 'tool', calls: msg.toolCall.functionCalls.map(({ id, name, args }) => ({ id, name, args: args || {} })) });
      return;
    }
    const c = msg.serverContent;
    if (!c) return;
    if (c.interrupted) this.send({ type: 'interrupted' });
    if (c.inputTranscription?.text) {
      this.note('user', c.inputTranscription.text);
      this.send({ type: 'in', text: c.inputTranscription.text });
    }
    if (c.outputTranscription?.text) {
      this.note('model', c.outputTranscription.text);
      this.send({ type: 'out', text: c.outputTranscription.text });
    }
    for (const part of c.modelTurn?.parts || []) {
      if (part.inlineData?.data && /^audio\//.test(part.inlineData.mimeType || '')) {
        const rate = Number(/rate=(\d+)/.exec(part.inlineData.mimeType)?.[1]) || 24000;
        this.send({ type: 'audio', data: part.inlineData.data, rate });
      }
    }
    if (c.turnComplete) this.send({ type: 'turn' });
  }

  // The same conversation on a new connection (its handle): Google takes it only once the old
  // connection is gone, so that one is closed first (and its closing is no longer this session's)
  async reconnect() {
    const old = this.ws;
    this.ws = null;
    if (old && old.readyState !== WebSocket.CLOSED) {
      await new Promise((resolve) => {
        old.addEventListener('close', resolve, { once: true });
        old.close();
        setTimeout(resolve, 2000);
      });
    }
    await this.connect();
  }

  // Another voice, mid-conversation. A resumed conversation keeps the voice it started with, so it's a
  // new one, handed what was said so far (as text), and she says a word in her new voice.
  async revoice(voice) {
    if (!VOICES.includes(voice) || voice === this.voice || this.closed) return;
    this.voice = voice;
    this.handle = null;
    try {
      await this.reconnect();
      const turns = this.said.slice(-HANDED_TURNS).map(({ role, text }) => ({ role, parts: [{ text }] }));
      if (turns.length) this.write({ clientContent: { turns, turnComplete: false } });
      this.text('(A note for you, not from the user: your voice just changed. Say one short line about how you sound now, in your own style and in the user\'s language.)');
    } catch (err) {
      this.end(err.message);
    }
  }

  write(obj) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  // a piece of your voice: 16 kHz, 16-bit mono PCM, base64
  audio(data) {
    this.write({ realtimeInput: { audio: { data, mimeType: 'audio/pcm;rate=16000' } } });
  }

  // you stopped the mic for a while: what's buffered is a whole turn
  audioEnd() {
    this.write({ realtimeInput: { audioStreamEnd: true } });
  }

  // a typed message, or news for her (Claude finished), as your turn
  text(text) {
    if (!text.startsWith('(A note for you')) this.note('user', text);
    this.write({ realtimeInput: { text } });
  }

  // what was said, as it's heard: [{ role: 'user' | 'model', text }], a turn per speaker in a row
  note(role, text) {
    const last = this.said.at(-1);
    if (last?.role === role) last.text += text;
    else this.said.push({ role, text });
    if (this.said.length > HANDED_TURNS * 2) this.said.splice(0, this.said.length - HANDED_TURNS);
  }

  // what her tools did: [{ id, name, response: {...} }]
  toolResponse(responses) {
    this.write({ toolResponse: { functionResponses: responses } });
  }

  close() {
    this.closed = true;
    this.ws?.close();
    this.end(null);
  }

  end(error) {
    if (this.ended) return;
    this.ended = true;
    this.closed = true;
    this.send({ type: 'state', state: 'closed', error });
  }
}

module.exports = { LiveSession, VOICES, liveModels };
