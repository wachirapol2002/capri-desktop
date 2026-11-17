// Talking with her out loud, in real time (Gemini Live, live.js in main): your microphone goes up
// as you speak, her voice comes back as she speaks, and you can cut her off. Her chat panel shows
// both sides as they're heard (and you can still type). Real work goes to Claude Code, in a window
// of its own (claudewin.js): she hands it over, then tells you when it's done or needs you.

import { fmt } from './util.js';

// while she speaks, only a voice louder than this counts as you talking over her (what's left of
// her own voice in the microphone, after the echo canceller, stays under it)
const OVER_HER = 0.035;
const SILENCE = new Int16Array(1600).buffer;

// what she can do in a live conversation (Gemini function calling)
const TOOLS = [
  {
    name: 'ask_claude',
    description: 'Hands a task to Claude Code, the user\'s AI coding assistant, which works in its own terminal window in their project. Use it for any real work on code, files or the computer. Returns right away: Claude works in the background, and you get a note when it finishes or needs the user\'s permission.',
    parameters: {
      type: 'OBJECT',
      properties: { task: { type: 'STRING', description: 'The task, as one clear and complete instruction, in the user\'s language.' } },
      required: ['task'],
    },
  },
  {
    name: 'claude_status',
    description: 'What Claude Code is doing right now, and what it got done today.',
    parameters: { type: 'OBJECT', properties: {} },
  },
  // what she does on your PC herself, as from her typed chat: quick things, no Claude Code needed
  {
    name: 'open_app',
    description: 'Opens an app, a game or a website on the user\'s PC by its name (Chrome, Discord, Spotify, Steam, YouTube, a Windows folder like Downloads...). Use it whenever the user asks to open or launch something.',
    parameters: {
      type: 'OBJECT',
      properties: { name: { type: 'STRING', description: 'The app, game or website name, as the user said it (in English if it has an English name).' } },
      required: ['name'],
    },
  },
  {
    name: 'play_music',
    description: 'Plays a song, an artist or a playlist: on Spotify (the app or its website), or the video itself on YouTube.',
    parameters: {
      type: 'OBJECT',
      properties: {
        query: { type: 'STRING', description: 'What to play: song, artist or playlist.' },
        where: { type: 'STRING', enum: ['spotify', 'youtube'], description: 'Where to play it. YouTube unless the user names Spotify.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'media_control',
    description: 'Controls the music or video playing on the PC (the media keys).',
    parameters: {
      type: 'OBJECT',
      properties: { action: { type: 'STRING', enum: ['pause', 'play', 'next', 'previous', 'volup', 'voldown', 'mute'] } },
      required: ['action'],
    },
  },
  {
    name: 'web_search',
    description: 'Searches Google in the user\'s browser.',
    parameters: { type: 'OBJECT', properties: { query: { type: 'STRING' } }, required: ['query'] },
  },
  {
    name: 'pc_request',
    description: 'Anything else Capri can do on the PC, said in words: set a timer or a reminder, a settings page, dark or light mode, the battery, disk space or RAM, sound volume to a level, Wi-Fi or Bluetooth on/off, screen brightness, a screenshot, find a file, free up space, what slows the PC, startup apps, app updates, game mode, tidy the windows, internet problems. Not shutting down or restarting.',
    parameters: {
      type: 'OBJECT',
      properties: { request: { type: 'STRING', description: 'The request as a short plain sentence, in the user\'s language (e.g. "ตั้งเวลา 10 นาที", "dark mode", "how much battery is left").' } },
      required: ['request'],
    },
  },
];

export class Live {
  constructor({ capri, panel, voice, host, brain, chat, guide }) {
    this.capri = capri;
    this.panel = panel;
    this.voice = voice;
    this.host = host;
    this.brain = brain;
    this.chat = chat;
    this.guide = guide;
    this.active = false;
    this.mic = null;        // { stream, ctx, node }
    this.sources = new Set(); // her voice, scheduled
    this.playAt = 0;
    this.heard = '';        // what you said this turn
    this.said = '';         // what she said this turn
    this.yourTurn = false;
    this.claudeSession = null; // the Claude Code conversation she handed work to
    host.onLiveEvent((evt) => this.onEvent(evt));
  }

  get t() {
    return this.brain.t.live;
  }

  get speaking() {
    return this.sources.size > 0;
  }

  async start() {
    if (this.active) return;
    const { t } = this;
    if (!(await this.host.liveHasKey())) {
      if (!(await this.askKey())) return;
    }
    if (this.capri.stowed) {
      this.host.setConfig({ visible: true });
      await this.capri.unstow();
    }
    this.capri.wake();
    this.active = true;
    this.heard = this.said = '';
    this.yourTurn = false;
    this.model = '…';
    if (!this.showPanel(t.connecting)) {
      this.active = false;
      return;
    }
    this.host.focusOverlay(true);
    this.capri.perform('hop');
    const res = await this.host.liveStart({ system: this.chat.persona({ live: true }), tools: TOOLS });
    if (!this.active) {
      if (res.ok) this.host.liveStop();
      return;
    }
    if (!res.ok) {
      this.fail(res.error === 'no key' ? t.noKey : fmt(t.failed, { error: res.error }));
      return;
    }    this.model = res.model.replace(/^gemini-/, '');
    if (this.onPanel) this.panel.tag.textContent = this.model;
    try {
      await this.openMic();
    } catch {
      this.fail(t.micDenied);
      return;
    }
    this.ui((p) => p.stream(t.listening, { done: true }));
  }

  // Her chat panel for it: closing it ends the conversation. Something more important taking its
  // place (Claude asking your permission) doesn't: you keep talking, and it comes back after.
  showPanel(line) {
    const { t } = this;
    const shown = this.panel.say({
      kind: 'chat', face: 'look', badge: t.badge, tag: this.model, line,
      chat: { placeholder: t.placeholder, send: this.chat.t.send, close: this.chat.t.close, noteTag: t.noteTag, note: t.note },
      onSend: (text) => this.typed(text),
      onLeave: (why) => {
        this.onPanel = false;
        if (why !== 'replaced') this.stop();
      },
      hold: null,
    });
    this.onPanel = shown;
    return shown;
  }

  // the panel again, once whatever took its place is gone (with her last line)
  backToPanel() {
    if (this.onPanel || !this.active || this.panel.visible) return;
    this.showPanel(this.said.trim() || this.chat.history.at(-1)?.content || this.t.listening);
  }

  // the Gemini key, asked in her panel (the same one as for her chat with Gemini)
  async askKey() {
    const { t } = this;
    let saved = false;
    await this.guide.scene(async () => {
      const got = await this.guide.askText({
        face: 'look', line: t.key, quote: t.keyHow, secret: true, tag: 'KEY',
        actions: [{ id: 'page', label: this.brain.t.setup.where }],
        onAction: (id) => id === 'page' && (this.host.keyPage('gemini'), true),
      });
      if (got?.text) saved = await this.host.liveKey(got.text);
    });
    return saved;
  }

  async openMic() {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const ctx = new AudioContext({ sampleRate: 16000 });
    await ctx.audioWorklet.addModule(new URL('./mic-worklet.js', import.meta.url));
    const node = new AudioWorkletNode(ctx, 'capri-mic');
    node.port.onmessage = ({ data }) => {
      if (!this.active) return;
      // while she talks, her own voice in your microphone must not cut her off: only a louder voice does
      const pcm = this.speaking && data.rms < OVER_HER ? SILENCE : data.pcm;
      this.host.liveAudio(toBase64(pcm));
    };
    ctx.createMediaStreamSource(stream).connect(node);
    this.mic = { stream, ctx, node };
  }

  closeMic() {
    if (!this.mic) return;
    this.mic.node.port.onmessage = null;
    this.mic.stream.getTracks().forEach((track) => track.stop());
    this.mic.ctx.close().catch(() => {});
    this.mic = null;
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    this.onPanel = false;
    this.closeMic();
    this.hush();
    this.host.liveStop();
    this.host.focusOverlay(false);
    this.capri.nextMove = performance.now() + 30000;
  }

  // her panel, if it's hers on screen (never over a permission prompt that took its place)
  ui(fn) {
    this.backToPanel();
    if (this.onPanel) fn(this.panel);
  }

  fail(line) {
    this.ui((p) => {
      p.setFace('wide');
      p.stream(line, { done: true });
    });
    this.closeMic();
    this.hush();
    this.host.liveStop();
    this.active = false;
  }

  typed(text) {
    if (!this.active) return;
    this.newTurn();
    this.heard = text;
    this.ui((p) => p.setQuote(text));
    this.host.liveText(text);
  }

  // you start talking (or typing): a new turn in her panel
  newTurn() {
    if (this.yourTurn) return;
    this.finishHers();
    this.yourTurn = true;
    this.heard = '';
    this.ui((p) => p.chatTurn({ quote: '', face: 'aside' }));
  }

  // what she said is all there: shown whole, and kept with her typed chat
  finishHers() {
    if (this.heard.trim()) this.chat.remember({ role: 'user', content: this.heard.trim() });
    const said = this.said.trim();
    if (said) {
      this.chat.remember({ role: 'assistant', content: said });
      this.ui((p) => p.stream(said, { done: true }));
    }
    this.said = '';
    this.heard = '';
  }

  onEvent(evt) {
    if (!this.active) return;
    switch (evt.type) {
      case 'in':
        this.newTurn();
        this.heard += evt.text;
        this.ui((p) => p.setQuote(this.heard.trim()));
        break;
      case 'out':
        if (this.yourTurn) {
          this.yourTurn = false;
          if (this.heard.trim()) this.chat.remember({ role: 'user', content: this.heard.trim() });
          this.heard = '';
        }
        this.said += evt.text;
        this.ui((p) => p.stream(this.said));
        break;
      case 'audio':
        if (!this.speaking) this.capri.perform('talk');
        this.play(evt.data, evt.rate);
        break;
      case 'interrupted': // you talked over her: she stops
        this.hush();
        if (this.said.trim()) this.ui((p) => p.stream(`${this.said.trim()}…`, { done: true }));
        break;
      case 'turn':
        this.yourTurn = false;
        this.finishHers();
        break;
      case 'tool':
        this.tools(evt.calls);
        break;
      case 'state':
        if (evt.state === 'closed') {
          if (evt.error) this.fail(fmt(this.t.failed, { error: evt.error }));
          else this.stop();
        }
        break;
      default:
    }
  }

  // her voice: 16-bit PCM pieces, one after the other, through her sounds' output
  play(base64, rate) {
    const ctx = this.voice.ensure();
    if (ctx.state === 'suspended') ctx.resume();
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const pcm = new Int16Array(bytes.buffer, 0, bytes.length >> 1);
    if (!pcm.length) return;
    const buffer = ctx.createBuffer(1, pcm.length, rate);
    const out = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] / 32768;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.voice.master);
    const at = Math.max(ctx.currentTime + 0.05, this.playAt);
    src.start(at);
    this.playAt = at + buffer.duration;
    this.sources.add(src);
    src.onended = () => this.sources.delete(src);
  }

  hush() {
    for (const src of this.sources) {
      try {
        src.stop();
      } catch {
        // not started yet
      }
    }
    this.sources.clear();
    this.playAt = 0;
  }

  async tools(calls) {
    const responses = [];
    for (const call of calls) {
      responses.push({ id: call.id, name: call.name, response: await this.tool(call).catch((err) => ({ error: err.message })) });
    }
    if (this.active) this.host.liveTool(responses);
  }

  async tool({ name, args }) {
    if (name === 'claude_status') return { status: this.brain.context() };
    const pc = await this.pcTool(name, args);
    if (pc) {
      if (pc.line) this.ui((p) => p.setQuote(pc.line)); // what she did, under what you said
      return pc;
    }
    if (name !== 'ask_claude') return { error: 'unknown tool' };
    const task = String(args.task || '').trim();
    if (!task) return { error: 'no task' };
    // still at the last one: it finishes first (you can see it in its window)
    const session = this.claudeSession || this.chat.claudeSession; // the same conversation as her typed chat's
    if (session && this.brain.busySessions.some((s) => s.id === session)) {
      return { status: 'busy', note: 'Claude Code is still working on the previous task. Tell the user to wait for it, or to type in its window.' };
    }
    const res = await this.host.claudeWindow(task);
    if (!res.ok) return { status: 'failed', error: res.error };
    this.claudeSession = res.session;
    this.ui((p) => p.setQuote(fmt(this.t.handed, { folder: res.folder.split(/[\\/]/).pop() })));
    return { status: 'started', folder: res.folder, note: 'Claude Code is working on it in its own window. You will get a note when it finishes or needs permission.' };
  }

  // Her own tools on your PC (chat.js does them, as from her typed chat): { ok, line }, or null when
  // `name` isn't one of them
  async pcTool(name, args) {
    const { chat, host } = this;
    const say = (ok, line) => ({ ok: Boolean(ok), line: line || '' });
    switch (name) {
      case 'open_app':
        return chat.openByName(String(args.name || '').trim());
      case 'play_music': {
        const query = String(args.query || '').trim();
        if (!query) return say(false, 'no query');
        if (args.where === 'spotify') {
          chat.zap();
          return say(await host.music(query), fmt(chat.t.music, { song: query }));
        }
        const done = await chat.youtube(query);
        return say(done, done?.line);
      }
      case 'media_control': {
        const action = String(args.action || '');
        if (!chat.t.media[action]) return say(false, 'unknown action');
        this.capri.pulse();
        return say(await host.media(action), chat.t.media[action]);
      }
      case 'web_search': {
        const query = String(args.query || '').trim();
        chat.zap();
        return say(query && (await host.webSearch(query)), fmt(chat.t.web, { query }));
      }
      case 'pc_request':
        return chat.doRequest(args.request);
      default:
        return null;
    }
  }

  // Claude Code's events (her hooks): the one she handed work to, finishing or waiting on you
  onClaudeEvent(evt) {
    if (!this.active || !this.claudeSession || evt.session_id !== this.claudeSession) return;
    const name = evt.hook_event_name;
    if (name === 'Stop') {
      const report = String(evt.last_assistant_message || '').slice(0, 3000);
      this.host.liveText(`(A note for you, not from the user: Claude Code finished the task. Its report:\n"""${report}"""\nTell the user in one or two short sentences what it did, in their language. Don't read the report out.)`);
    } else if (name === 'Notification' && /permission|approv|allow/i.test(evt.message || '')) {
      this.host.liveText(`(A note for you, not from the user: Claude Code is waiting for the user's permission in its window: "${String(evt.message || '').slice(0, 300)}". Tell them in a few words to look at Claude's window.)`);
    } else if (name === 'StopFailure') {
      this.host.liveText(`(A note for you, not from the user: Claude Code stopped with an error: "${String(evt.error || evt.message || '').slice(0, 300)}". Tell the user briefly.)`);
    }
  }
}

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
