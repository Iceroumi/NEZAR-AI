#!/usr/bin/env node
/*
 * Установщик NEZAR Native Messaging Host для Linux.
 *
 * Запуск:
 *   node install-linux.js <extension_id>
 *
 * Что делает:
 *   1. Копирует манифест в ~/.config/google-chrome/NativeMessagingHosts/
 *      (также Edge, Brave, Chromium)
 *   2. Создаёт launcher ~/.local/bin/nezar-host.sh и делает его исполняемым
 *   3. Регистрирует правильный extension_id
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const EXTENSION_ID = process.argv[2] || process.env.NEZAR_EXTENSION_ID;
if (!EXTENSION_ID) {
  console.error('Usage: node install-linux.js <extension_id>');
  console.error('   or: NEZAR_EXTENSION_ID=xxxx node install-linux.js');
  process.exit(1);
}

const SCRIPT_DIR = __dirname;
const HOST_JS = path.join(SCRIPT_DIR, 'host.js');

if (!fs.existsSync(HOST_JS)) {
  console.error('host.js not found at ' + HOST_JS);
  process.exit(1);
}

const home = os.homedir();
const NODE_BIN = process.execPath;

const TARGETS = [
  { name: 'Google Chrome',  dir: path.join(home, '.config/google-chrome/NativeMessagingHosts') },
  { name: 'Chromium',       dir: path.join(home, '.config/chromium/NativeMessagingHosts') },
  { name: 'Microsoft Edge', dir: path.join(home, '.config/microsoft-edge/NativeMessagingHosts') },
  { name: 'Brave',          dir: path.join(home, '.config/BraveSoftware/Brave-Browser/NativeMessagingHosts') },
  { name: 'Vivaldi',        dir: path.join(home, '.config/vivaldi/NativeMessagingHosts') },
];

// ~/.local/bin обычно уже в PATH; иначе добавим в инструкцию
const LAUNCHER_DIR = path.join(home, '.local/bin');
const LAUNCHER_PATH = path.join(LAUNCHER_DIR, 'nezar-host.sh');
const LAUNCHER_CONTENT = `#!/bin/bash
# NEZAR Native Messaging Host launcher (auto-generated)
exec "${NODE_BIN}" "${HOST_JS}"
`;

console.log('=== NEZAR Native Host installer (Linux) ===');
console.log('Extension ID: ' + EXTENSION_ID);
console.log('Node binary:  ' + NODE_BIN);
console.log('host.js:      ' + HOST_JS);
console.log('');

try {
  fs.mkdirSync(LAUNCHER_DIR, { recursive: true });
  fs.writeFileSync(LAUNCHER_PATH, LAUNCHER_CONTENT, { mode: 0o755 });
  fs.chmodSync(LAUNCHER_PATH, 0o755);
  console.log('[OK] Launcher written: ' + LAUNCHER_PATH);
} catch (e) {
  console.error('[FAIL] Cannot write ' + LAUNCHER_PATH + ': ' + e.message);
  process.exit(1);
}

const manifestContent = JSON.stringify({
  name: 'com.nezar.host',
  description: 'NEZAR Native Messaging Host — bridge between browser extension and OS terminal',
  path: LAUNCHER_PATH,
  type: 'stdio',
  allowed_origins: [
    `chrome-extension://${EXTENSION_ID}/`,
  ],
}, null, 2);

for (const target of TARGETS) {
  try {
    fs.mkdirSync(target.dir, { recursive: true });
    const manifestPath = path.join(target.dir, 'com.nezar.host.json');
    fs.writeFileSync(manifestPath, manifestContent, { mode: 0o644 });
    console.log('[OK] ' + target.name + ': ' + manifestPath);
  } catch (e) {
    console.error('[SKIP] ' + target.name + ': ' + e.message);
  }
}

console.log('');
console.log('=== Installation complete ===');
console.log('Make sure ~/.local/bin is in your PATH (usually yes).');
console.log('Restart your browser, then reload the NEZAR extension.');
