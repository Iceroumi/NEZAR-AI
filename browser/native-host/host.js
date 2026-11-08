#!/usr/bin/env node
/*
 * NEZAR Native Messaging Host
 * ============================
 * Принимает сообщения от браузерного расширения (Chrome/Edge) по протоколу
 * Native Messaging (4-байта little-endian длина + UTF-8 JSON), выполняет
 * команду в ОС через child_process.spawn и возвращает stdout/stderr/exitCode.
 *
 * Протокол:
 *   ВХОД:  { "id": "<reqId>", "command": "npm run build", "cwd": "/path", "timeout": 60000 }
 *   ВЫХОД: { "id": "<reqId>", "type": "stdout", "text": "..." }
 *          { "id": "<reqId>", "type": "stderr", "text": "..." }
 *          { "id": "<reqId>", "type": "done", "exitCode": 0 }
 *          { "id": "<reqId>", "type": "error", "error": "..." }
 *
 * Также отвечает на ping:
 *   ВХОД:  { "id": "x", "type": "ping" }
 *   ВЫХОД: { "id": "x", "type": "pong", "version": "0.1.0", "platform": "linux" }
 *
 * Запуск: см. install-*.js скрипты — они регистрируют этот файл в ОС.
 */

const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const HOST_VERSION = '0.1.0';
const MAX_MESSAGE_SIZE = 10 * 1024 * 1024; // 10 MB лимит на одно сообщение

// ============================================================
// Чтение сообщений из stdin (протокол Native Messaging)
// ============================================================
let stdinBuffer = Buffer.alloc(0);

function readMessage() {
  // Нужно минимум 4 байта для длины
  if (stdinBuffer.length < 4) return null;

  const length = stdinBuffer.readUInt32LE(0);
  if (length > MAX_MESSAGE_SIZE) {
    logToStderr('Message too large: ' + length);
    process.exit(1);
  }

  if (stdinBuffer.length < 4 + length) return null;

  const raw = stdinBuffer.slice(4, 4 + length);
  stdinBuffer = stdinBuffer.slice(4 + length);

  try {
    return JSON.parse(raw.toString('utf8'));
  } catch (e) {
    logToStderr('JSON parse error: ' + e.message);
    return null;
  }
}

function logToStderr(msg) {
  // stderr НЕ виден браузером — только для отладки (journalctl / Event Viewer)
  process.stderr.write('[nezar-host] ' + msg + '\n');
}

// ============================================================
// Отправка сообщений в stdout (протокол Native Messaging)
// ============================================================
function sendMessage(obj) {
  const json = Buffer.from(JSON.stringify(obj), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  process.stdout.write(Buffer.concat([header, json]));
}

// ============================================================
// Выполнение команды
// ============================================================
function runCommand(msg) {
  const reqId = msg.id || ('req_' + Date.now());
  const command = msg.command;
  const cwd = msg.cwd || os.homedir();
  const timeout = msg.timeout || 60000;
  const shell = msg.shell !== false; // по умолчанию true

  if (!command || typeof command !== 'string') {
    sendMessage({ id: reqId, type: 'error', error: 'No command provided' });
    return;
  }

  // Проверяем cwd
  try {
    if (!fs.existsSync(cwd)) {
      sendMessage({ id: reqId, type: 'error', error: 'cwd does not exist: ' + cwd });
      return;
    }
  } catch (e) {
    sendMessage({ id: reqId, type: 'error', error: 'cwd check failed: ' + e.message });
    return;
  }

  logToStderr('RUN: ' + command + ' (cwd=' + cwd + ', timeout=' + timeout + ')');

  // Выбираем shell в зависимости от ОС
  const isWin = process.platform === 'win32';
  const child = spawn(command, {
    cwd: cwd,
    shell: shell,
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    windowsHide: true,
    maxBuffer: 5 * 1024 * 1024,
  });

  let stdoutBuf = '';
  let stderrBuf = '';
  let killed = false;

  // Стримим stdout
  child.stdout.on('data', (data) => {
    const text = data.toString('utf8');
    stdoutBuf += text;
    sendMessage({ id: reqId, type: 'stdout', text: text });
  });

  // Стримим stderr
  child.stderr.on('data', (data) => {
    const text = data.toString('utf8');
    stderrBuf += text;
    sendMessage({ id: reqId, type: 'stderr', text: text });
  });

  // Таймаут
  const timer = setTimeout(() => {
    killed = true;
    try { child.kill('SIGTERM'); } catch (e) {}
    setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (e) {}
    }, 1000);
    sendMessage({ id: reqId, type: 'error', error: 'Timeout after ' + timeout + 'ms', stdout: stdoutBuf, stderr: stderrBuf });
  }, timeout);

  child.on('error', (err) => {
    clearTimeout(timer);
    logToStderr('SPAWN ERROR: ' + err.message);
    sendMessage({ id: reqId, type: 'error', error: 'Spawn failed: ' + err.message });
  });

  child.on('close', (code) => {
    clearTimeout(timer);
    if (killed) return; // уже отправили error
    logToStderr('DONE exitCode=' + code);
    sendMessage({
      id: reqId,
      type: 'done',
      exitCode: code,
      stdout: stdoutBuf,
      stderr: stderrBuf,
    });
  });
}

// ============================================================
// Главная петля чтения stdin
// ============================================================
process.stdin.on('data', (chunk) => {
  stdinBuffer = Buffer.concat([stdinBuffer, chunk]);

  // Читаем все накопленные сообщения
  let msg;
  while ((msg = readMessage()) !== null) {
    handleMessage(msg);
  }
});

process.stdin.on('end', () => {
  logToStderr('stdin ended, exiting');
  process.exit(0);
});

process.stdin.on('error', (e) => {
  logToStderr('stdin error: ' + e.message);
  process.exit(1);
});

function handleMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  logToStderr('RECV: ' + JSON.stringify(msg).slice(0, 200));

  // Ping/Pong для проверки связи
  if (msg.type === 'ping') {
    sendMessage({
      id: msg.id,
      type: 'pong',
      version: HOST_VERSION,
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      homedir: os.homedir(),
    });
    return;
  }

  // Выполнение команды
  if (msg.command !== undefined) {
    runCommand(msg);
    return;
  }

  // Неизвестный запрос
  sendMessage({ id: msg.id || 'unknown', type: 'error', error: 'Unknown message format' });
}

// Логируем запуск
logToStderr('NEZAR Native Host v' + HOST_VERSION + ' started on ' + process.platform + '/' + process.arch);
logToStderr('Node: ' + process.version + ', PID: ' + process.pid);
