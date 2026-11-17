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
// Its rules in her windows, over your own settings: it asks you before every change to a file, even
// as administrator and whatever mode your settings start it in (an ask rule beats an allow rule)
const settingsFile = path.join(os.tmpdir(), `capri-claude-${process.pid}.settings.json`);
const ASK_FIRST = { permissions: { defaultMode: 'default', ask: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'] } };

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
  } catch (err) {
    return err.code === 'EPERM'; // there, but an administrator's: not ours to touch
  }
}

// the window before, and Claude in it: its conversation is saved, the next window picks it up.
// False when it's still there: one run as administrator can't be closed from here.
async function closePrevious() {
  const n = pid || readPid();
  pid = null;
  if (!alive(n)) return true;
  await new Promise((resolve) => execFile('taskkill', ['/PID', String(n), '/T', '/F'], { windowsHide: true }, () => resolve()));
  await new Promise((resolve) => setTimeout(resolve, 300));
  if (!alive(n)) return true;
  pid = n;
  return false;
}

// a PowerShell script, run hidden: its exit code (UAC declined: not 0)
function runHidden(script) {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { windowsHide: true, timeout: 120000 }, (err) => resolve(err ? err.code || 1 : 0));
  });
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

// `task` to Claude Code in `cwd`, in a new window: { ok, session } or { ok: false, error }.
// admin: as administrator (Windows asks you first, every time: UAC)
async function run(task, cwd, { admin = false } = {}) {
  if (process.platform !== 'win32') return { ok: false, error: 'Windows only' };
  const folder = cwd && fs.existsSync(cwd) ? cwd : os.homedir();
  if (!(await closePrevious())) {
    return { ok: false, error: 'The previous Claude Code window (run as administrator) is still open: the user has to close it first.' };
  }
  if (!session) session = randomUUID();
  const resume = started;
  // the task from a file (UTF-8), never on a command line; PowerShell hands it to claude (claude.ps1
  // from npm, or claude.exe) as one argument. Windows PowerShell hands a double quote inside an
  // argument on badly: single ones instead.
  fs.writeFileSync(taskFile, String(task).replace(/"/g, "'").slice(0, 4000), 'utf8');
  fs.writeFileSync(settingsFile, JSON.stringify(ASK_FIRST), 'utf8');
  const script = [
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    '[Console]::InputEncoding = [Text.Encoding]::UTF8',
    `$host.UI.RawUI.WindowTitle = ${literal(admin ? `${TITLE} (admin)` : TITLE)}`,
    // (an administrator's window starts in System32, whatever it's told)
    `Set-Location -LiteralPath ${literal(folder)}`,
    `Set-Content -LiteralPath ${literal(pidFile)} -Value $PID`,
    `$task = Get-Content -Raw -Encoding UTF8 -LiteralPath ${literal(taskFile)}`,
    `& claude --permission-mode default --settings ${literal(settingsFile)} ${resume ? '--resume' : '--session-id'} ${literal(session)} $task`,
  ].join('\n');
  const ps = ['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
  try {
    fs.rmSync(pidFile, { force: true });
    const wt = await findTerminal();
    if (admin) {
      // Start-Process -Verb RunAs: Windows asks (UAC), then the window opens as administrator, in a
      // window of its own (Windows Terminal doesn't mix them with ordinary tabs)
      const inner = `-NoProfile -ExecutionPolicy Bypass -EncodedCommand ${ps.at(-1)}`;
      const [file, args] = wt
        ? ['wt.exe', `-w capri-claude-admin new-tab --title "${TITLE} (admin)" powershell.exe ${inner}`]
        : ['powershell.exe', inner];
      const code = await runHidden(`try { Start-Process -Verb RunAs -FilePath ${literal(file)} -ArgumentList ${literal(args)} -ErrorAction Stop } catch { exit 5 }`);
      if (code) return { ok: false, error: 'Windows did not get permission to run Claude Code as administrator (UAC declined).' };
      started = true;
      setTimeout(() => { pid = readPid(); }, 4000);
      return { ok: true, session, folder, admin: true };
    }
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
