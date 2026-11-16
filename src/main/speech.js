'use strict';

// Her voice from a text-to-speech service: Microsoft Edge's online voices, Google Translate's,
// Windows' own voices, one running on your PC that speaks
// OpenAI's speech API (Kokoro-FastAPI, openedai-speech…), OpenAI's own, or ElevenLabs'. Returns the
// audio (wav or mp3) for the overlay to play; the keys never leave this process.

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Windows' voices through its own speech engine (WinRT, run by PowerShell): unlike Chromium's
// speechSynthesis, it sees every voice Windows has, the newer ones too (Thai's Pattara is only
// there). Its input comes in environment variables, never on the command line.
const WINDOWS_SCRIPT = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType = WindowsRuntime]
$all = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices
if ($env:CAPRI_TTS_LIST) { [Console]::Out.Write((($all | ForEach-Object { $_.DisplayName + '|' + $_.Language }) -join [char]10)); exit }
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' } | Select-Object -First 1
$lang = $env:CAPRI_TTS_LANG
$s = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer
$v = $all | Where-Object { $_.DisplayName -eq $env:CAPRI_TTS_VOICE -and $_.Language.StartsWith($lang) } | Select-Object -First 1
if (-not $v) { $v = $all | Where-Object { $_.Language.StartsWith($lang) -and $_.Gender -eq 'Female' } | Select-Object -First 1 }
if (-not $v) { $v = $all | Where-Object { $_.Language.StartsWith($lang) } | Select-Object -First 1 }
if (-not $v) { [Console]::Error.Write("no Windows voice for $lang"); exit 2 }
$s.Voice = $v
try { $s.Options.SpeakingRate = [double]::Parse($env:CAPRI_TTS_RATE, [Globalization.CultureInfo]::InvariantCulture) } catch {}
$task = $asTask.MakeGenericMethod([Windows.Media.SpeechSynthesis.SpeechSynthesisStream]).Invoke($null, @($s.SynthesizeTextToStreamAsync($env:CAPRI_TTS_TEXT)))
$null = $task.Wait(-1)
$ms = New-Object System.IO.MemoryStream
[System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($task.Result).CopyTo($ms)
[Console]::Out.Write([Convert]::ToBase64String($ms.ToArray()))
`;
const WINDOWS_ENCODED = Buffer.from(WINDOWS_SCRIPT, 'utf16le').toString('base64');

function runWindows(env) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', WINDOWS_ENCODED],
      { env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024, timeout: TIMEOUT_MS, windowsHide: true },
      (err, out, errOut) => (err ? reject(new Error(String(errOut || err.message).replace(/#< CLIXML[\s\S]*$/, '').trim().slice(0, 160) || 'Windows voice failed')) : resolve(out)));
  });
}

// Windows' voices: [{ name, lang }] ('Microsoft Pattara', 'th-TH'), [] when it can't say
async function windowsVoices() {
  if (process.platform !== 'win32') return [];
  const out = await runWindows({ CAPRI_TTS_LIST: '1' }).catch(() => '');
  return out.split('\n').filter(Boolean).map((row) => {
    const [name, lang] = row.split('|');
    return { name: name.trim(), lang: (lang || '').trim() };
  });
}

// The language a line is in, for Windows to pick a voice that can read it: Thai by its letters
// (her chat answers in yours), her own language otherwise.
const langOf = (text, fallback) => (/[฀-๿]/.test(text) ? 'th' : fallback || 'en');

const SERVICES = {
  windows: { voice: '' },
  edge: { voice: 'th-TH-PremwadeeNeural' },
  google: { voice: '' },
  local: { url: 'http://127.0.0.1:8880/v1', voice: 'af_bella', model: 'kokoro' },
  openai: { url: 'https://api.openai.com/v1', voice: 'shimmer', model: 'gpt-4o-mini-tts' },
  elevenlabs: { url: 'https://api.elevenlabs.io/v1', voice: '', model: 'eleven_flash_v2_5' },
};

// How she sounds, for the services that take a direction (OpenAI's gpt-4o-mini-tts)
const STYLE = 'A young woman, cool and a little teasing, with a dry sense of humor. Low-to-mid pitch, '
  + 'slightly husky, relaxed pace, clear words. Confident, never bubbly, never robotic.';

// Her lines come back often ("Mission terminée", her greetings): the last ones asked for are kept.
const CACHE_MAX = 40;
const cache = new Map();

const TIMEOUT_MS = 20000;

// How fast she speaks: x0.5 to x2 (1 is the voice's own pace)
const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2];
const clampRate = (rate) => Math.min(2, Math.max(0.5, Number(rate) || 1));

// `text` spoken by `service` ({ provider, voice, url, rate } from her config, `key` for it): the
// audio as a Buffer, or throws with what went wrong, in a few words. Google's comes at its own pace:
// the overlay speeds it up (stretch() says by how much).
async function synthesize(text, { provider, voice, url, rate }, key = '', uiLang = 'en') {
  const s = SERVICES[provider];
  if (!s) throw new Error('no voice service');
  const input = String(text).trim().slice(0, 600);
  if (!input) throw new Error('nothing to say');
  const name = voice || s.voice;
  const lang = langOf(input, uiLang);
  const speed = clampRate(rate);
  const id = `${provider}|${url || ''}|${name}|${lang}|${provider === 'google' ? 1 : speed}|${input}`;
  if (cache.has(id)) {
    const hit = cache.get(id);
    cache.delete(id); // most recent last
    cache.set(id, hit);
    return hit;
  }
  const audio = await make(input, { provider, s, name, url, lang, speed }, key);
  if (!audio.length) throw new Error('no audio');
  cache.set(id, audio);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return audio;
}

// How much the overlay speeds up what synthesize() gave (the services that can't do it themselves)
const stretch = ({ provider, rate }) => (provider === 'google' ? clampRate(rate) : 1);

async function make(input, { provider, s, name, url, lang, speed }, key) {
  if (provider === 'windows') {
    if (process.platform !== 'win32') throw new Error('Windows only');
    return Buffer.from(await runWindows({ CAPRI_TTS_TEXT: input, CAPRI_TTS_VOICE: name, CAPRI_TTS_LANG: lang, CAPRI_TTS_RATE: String(speed) }), 'base64');
  }
  if (provider === 'edge') return edgeSay(input, name || EDGE_VOICES[0].id, speed);
  if (provider === 'google') return googleSay(input, lang);
  if (provider !== 'local' && !key) throw new Error('no key');

  let res;
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  if (provider === 'elevenlabs') {
    if (!name) throw new Error('no voice id');
    res = await fetch(`${s.url}/text-to-speech/${encodeURIComponent(name)}?output_format=mp3_44100_64`, {
      method: 'POST',
      headers: { 'xi-api-key': key, 'content-type': 'application/json', accept: 'audio/mpeg' },
      body: JSON.stringify({ text: input, model_id: s.model, voice_settings: { speed: Math.min(1.2, Math.max(0.7, speed)) } }),
      signal,
    });
  } else {
    const base = (provider === 'local' ? (url || s.url) : s.url).replace(/\/+$/, '');
    const body = { model: s.model, voice: name, input, response_format: 'mp3', speed };
    if (provider === 'openai') body.instructions = STYLE;
    res = await fetch(`${base}/audio/speech`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key && { authorization: `Bearer ${key}` }) },
      body: JSON.stringify(body),
      signal,
    });
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 120);
    throw new Error(`${res.status}${detail ? ` ${detail}` : ''}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

// --- Microsoft Edge's online voices ---------------------------------------------------------------
// Through the edge-tts Python package (`python -m edge_tts`): it keeps up with what Microsoft's
// service asks of its clients, so an update of it (`pip install -U edge-tts`) is all a change there
// takes. Free, no account; the text goes to Microsoft.

const EDGE_VOICES = [
  { id: 'th-TH-PremwadeeNeural', label: 'Premwadee', lang: 'th', gender: 'f' },
  { id: 'th-TH-NiwatNeural', label: 'Niwat', lang: 'th', gender: 'm' },
  { id: 'en-US-EmmaMultilingualNeural', label: 'Emma (multilingual)', lang: 'en', gender: 'f' },
  { id: 'en-US-AndrewMultilingualNeural', label: 'Andrew (multilingual)', lang: 'en', gender: 'm' },
];

// Python on this PC: `python`, else the `py` launcher
let python = null;
function findPython() {
  if (python) return Promise.resolve(python);
  const tryOne = (cmd) => new Promise((resolve) => {
    execFile(cmd, ['--version'], { timeout: 10000, windowsHide: true }, (err, out) => resolve(!err && /Python 3/.test(out) ? cmd : null));
  });
  return tryOne('python').then((found) => found || tryOne('py')).then((found) => {
    python = found;
    return found;
  });
}

function runPython(args, timeout = TIMEOUT_MS) {
  return findPython().then((cmd) => {
    if (!cmd) throw new Error('no python');
    return new Promise((resolve, reject) => {
      execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } }, (err, out, errOut) => {
        if (!err) return resolve(out);
        const why = String(errOut || err.message);
        reject(new Error(/No module named edge_tts/.test(why) ? 'no edge-tts' : why.trim().split('\n').pop().slice(0, 160)));
      });
    });
  });
}

async function edgeSay(input, voice, speed) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capri-tts-'));
  try {
    // the text from a file, never on the command line
    const textFile = path.join(dir, 'text.txt');
    const audioFile = path.join(dir, 'voice.mp3');
    fs.writeFileSync(textFile, input, 'utf8');
    const percent = Math.round((speed - 1) * 100);
    await runPython(['-m', 'edge_tts', '--voice', voice, `--rate=${percent >= 0 ? '+' : ''}${percent}%`, '-f', textFile, '--write-media', audioFile]);
    return fs.readFileSync(audioFile);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Whether edge-tts is there: 'ok', 'no-python' or 'missing'
async function edgeState() {
  if (!(await findPython())) return 'no-python';
  return runPython(['-c', 'import edge_tts'], 15000).then(() => 'ok', () => 'missing');
}

// Installs it for this Windows user (pip): true once done
function installEdge() {
  return runPython(['-m', 'pip', 'install', '--user', '--upgrade', 'edge-tts'], 180000).then(() => true, () => false);
}

// --- Google Translate's voice -----------------------------------------------------------------------
// The one its website reads with: free, no account, but Google stops answering an address for a
// while after heavy use. Up to 200 characters per request; mp3 pieces simply join up.

const GOOGLE_MAX = 200;

function pieces(text, max) {
  const out = [];
  let rest = text;
  while (rest.length > max) {
    const cut = rest.slice(0, max);
    // at the end of a sentence, else a space (Thai puts one between sentences), else anywhere
    let at = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '), cut.lastIndexOf('。'));
    if (at < max / 3) at = cut.lastIndexOf(' ');
    if (at < max / 3) at = max - 1;
    out.push(rest.slice(0, at + 1).trim());
    rest = rest.slice(at + 1).trim();
  }
  if (rest) out.push(rest);
  return out.filter(Boolean);
}

async function googleSay(input, lang) {
  const parts = [];
  for (const piece of pieces(input, GOOGLE_MAX)) {
    const query = new URLSearchParams({ ie: 'UTF-8', q: piece, tl: lang, client: 'tw-ob' });
    const res = await fetch(`https://translate.google.com/translate_tts?${query}`, {
      headers: { 'user-agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 429) throw new Error('Google: too many requests, wait a little');
    if (!res.ok || !(res.headers.get('content-type') || '').startsWith('audio')) throw new Error(`Google: ${res.status}`);
    parts.push(Buffer.from(await res.arrayBuffer()));
  }
  return Buffer.concat(parts);
}

module.exports = { synthesize, stretch, windowsVoices, edgeState, installEdge, SERVICES, EDGE_VOICES, RATES };
