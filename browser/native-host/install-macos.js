#!/usr/bin/env node
/*
 * Установщик NEZAR Native Messaging Host для macOS.
 *
 * Запуск:
 *   node install-macos.js <extension_id>
 *
 * Что делает:
 *   1. Создаёт директорию ~/Library/Application Support/Google/Chrome/NativeMessagingHosts
 *      (для Edge: ~/Library/Application Support/Microsoft Edge/NativeMessagingHosts)
 *   2. Копирует com.nezar.host.json в эту директорию, подставляя правильный extension_id
 *   3. Создаёт launcher-скрипт /usr/local/bin/nezar-host.sh (через который запускается host.js)
 *   4. Даёт права на запуск
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const EXTENSION_ID = process.argv[2] || process.env.NEZAR_EXTENSION_ID;
if (!EXTENSION_ID) {
  console.error('Usage: node install-macos.js <extension_id>');
  console.error('   or: NEZAR_EXTENSION_ID=xxxx node install-macos.js');
  process.exit(1);
}

const SCRIPT_DIR = __dirname;
const HOST_JS = path.join(SCRIPT_DIR, 'host.js');
const MANIFEST_TEMPLATE = path.join(SCRIPT_DIR, 'com.nezar.host.json');

if (!fs.existsSync(HOST_JS)) {
  console.error('host.js not found at ' + HOST_JS);
  process.exit(1);
}
if (!fs.existsSync(MANIFEST_TEMPLATE)) {
  console.error('com.nezar.host.json not found at ' + MANIFEST_TEMPLATE);
  process.exit(1);
}

const home = os.homedir();

// Пути для Chrome и Edge на macOS
const TARGETS = [
  {
    name: 'Google Chrome',
    dir: path.join(home, 'Library/Application Support/Google/Chrome/NativeMessagingHosts'),
  },
  {
    name: 'Microsoft Edge',
    dir: path.join(home, 'Library/Application Support/Microsoft Edge/NativeMessagingHosts'),
  },
  {
    name: 'Brave',
    dir: path.join(home, 'Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts'),
  },
];

// Launcher script — нужен, чтобы Chrome мог запускать Node-скрипт.
// Chrome вызывает путь из "path" поля манифеста как исполняемый файл.
const NODE_BIN = process.execPath;
const LAUNCHER_PATH = '/usr/local/bin/nezar-host.sh';
const LAUNCHER_CONTENT = `#!/bin/bash
# NEZAR Native Messaging Host launcher (auto-generated)
exec "${NODE_BIN}" "${HOST_JS}"
`;

console.log('=== NEZAR Native Host installer (macOS) ===');
console.log('Extension ID: ' + EXTENSION_ID);
console.log('Node binary:  ' + NODE_BIN);
console.log('host.js:      ' + HOST_JS);
console.log('');

// 1. Пишем launcher
try {
  fs.writeFileSync(LAUNCHER_PATH, LAUNCHER_CONTENT, { mode: 0o755 });
  execSync(`chmod +x "${LAUNCHER_PATH}"`);
  console.log('[OK] Launcher written: ' + LAUNCHER_PATH);
} catch (e) {
  console.error('[FAIL] Cannot write ' + LAUNCHER_PATH + ': ' + e.message);
  console.error('       Try: sudo node install-macos.js ' + EXTENSION_ID);
  process.exit(1);
}

// 2. Регистрируем манифест в каждом браузере
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
console.log('Restart your browser, then reload the NEZAR extension.');
console.log('Test: open NEZAR dashboard → Blockly → block "терминал native" → run "echo hello"');
