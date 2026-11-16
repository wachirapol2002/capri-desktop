'use strict';

// Claude Code in a window of its own, for what you ask her out loud (live.js): a real terminal you
// can read, where you answer its permission prompts yourself. Her hooks see it like any Claude Code,
// so she tells you what it's up to, when it needs you and when it's done.
//
// One conversation: the first task starts it, each next one picks it up again (--resume) in a new
// window, the previous one closed first if it's still open. The task goes in through a file, never
// through a command line a shell could read something else into.

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');

let session = null;   // its conversation's id
let started = false;  // a first task went in: the next ones resume it
let pid = null;       // the window's PowerShell, to close it before the next one
const pidFile = path.join(os.tmpdir(), `capri-claude-${process.pid}.pid`);
const taskFile = path.join(os.tmpdir(), `capri-claude-${process.pid}.txt`);

const TITLE = 'Claude Code - Capri';

function readPid() {
  try {
    const n = Number(fs.readFileSync(pidFile, 'utf8').trim());
    return n > 0 ? n : null;
  } catch {
    return null;
  }
}

function alive(n) {
  if (!n) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch {
    return false;
  }
}

// the window before, and Claude in it: its conversation is saved, the next window picks it up
function closePrevious() {
  const n = pid || readPid();
  pid = null;
  if (!alive(n)) return Promise.resolve();
  return new Promise((resolve) => execFile('taskkill', ['/PID', String(n), '/T', '/F'], { windowsHide: true }, () => resolve()));
}

// Windows Terminal, if it's there: it shows Thai (and Claude's logo); the old console's fonts don't
let terminal;
function findTerminal() {
  if (terminal !== undefined) return Promise.resolve(terminal);
  return new Promise((resolve) => {
    execFile('where.exe', ['wt.exe'], { windowsHide: true, timeout: 5000 }, (err, out) => {
      terminal = !err && out.trim() ? 'wt.exe' : null;
      resolve(terminal);
    });
  });
}

const literal = (text) => `'${String(text).replace(/'/g, "''")}'`; // a PowerShell string, as is

// `task` to Claude Code in `cwd`, in a new window: { ok, session } or { ok: false, error }
async function run(task, cwd) {
  if (process.platform !== 'win32') return { ok: false, error: 'Windows only' };
  const folder = cwd && fs.existsSync(cwd) ? cwd : os.homedir();
  await closePrevious();
  if (!session) session = randomUUID();
  const resume = started;
  // the task from a file (UTF-8), never on a command line; PowerShell hands it to claude (claude.ps1
  // from npm, or claude.exe) as one argument. Windows PowerShell hands a double quote inside an
  // argument on badly: single ones instead.
  fs.writeFileSync(taskFile, String(task).replace(/"/g, "'").slice(0, 4000), 'utf8');
  const script = [
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    '[Console]::InputEncoding = [Text.Encoding]::UTF8',
    `$host.UI.RawUI.WindowTitle = ${literal(TITLE)}`,
    `Set-Content -LiteralPath ${literal(pidFile)} -Value $PID`,
    `$task = Get-Content -Raw -Encoding UTF8 -LiteralPath ${literal(taskFile)}`,
    `& claude ${resume ? '--resume' : '--session-id'} ${literal(session)} $task`,
  ].join('\n');
  const ps = ['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
  try {
    fs.rmSync(pidFile, { force: true });
    const wt = await findTerminal();
    // Windows Terminal: a tab in her own window ("capri-claude"), in that folder. Without it, `start`
    // gives it a console of its own (a detached child alone would get no keyboard).
    const child = wt
      // (windowsHide would hide Windows Terminal's own window, the one you're meant to read)
      ? spawn(wt, ['-w', 'capri-claude', 'new-tab', '--title', TITLE, '-d', '.', ...ps], { cwd: folder, windowsHide: false, stdio: 'ignore', detached: true })
      : spawn('cmd.exe', [`/d /c start "${TITLE}" ${ps.join(' ')}`], { cwd: folder, windowsVerbatimArguments: true, windowsHide: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
    started = true;
    setTimeout(() => { pid = readPid(); }, 3000);
    return { ok: true, session, folder };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

const isSession = (id) => Boolean(id) && id === session;

module.exports = { run, isSession };
