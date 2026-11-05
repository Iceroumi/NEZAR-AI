/*
 * Установщик NEZAR Native Messaging Host для Windows.
 *
 * Запуск (в cmd или PowerShell):
 *   node install-windows.js <extension_id>
 *
 * Что делает:
 *   1. Создаёт launcher .cmd и .bat в %USERPROFILE%\nezar-host\
 *   2. Регистрирует в реестре HKEY_CURRENT_USER\Software\Google\Chrome\NativeMessagingHosts\com.nezar.host
 *      (также для Edge)
 *   3. Пишет манифест com.nezar.host.json рядом с launcher-ом
 *
 * НЕ требует админских прав — всё в HKCU и %USERPROFILE%.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const EXTENSION_ID = process.argv[2] || process.env.NEZAR_EXTENSION_ID;
if (!EXTENSION_ID) {
  console.error('Usage: node install-windows.js <extension_id>');
  console.error('   or: set NEZAR_EXTENSION_ID=xxxx && node install-windows.js');
  process.exit(1);
}

const SCRIPT_DIR = __dirname;
const HOST_JS = path.resolve(SCRIPT_DIR, 'host.js');

if (!fs.existsSync(HOST_JS)) {
  console.error('host.js not found at ' + HOST_JS);
  process.exit(1);
}

const home = os.homedir();
const HOST_DIR = path.join(home, 'nezar-host');
const LAUNCHER_PATH = path.join(HOST_DIR, 'nezar-host.bat');
const MANIFEST_PATH = path.join(HOST_DIR, 'com.nezar.host.json');
const NODE_BIN = process.execPath;

// Windows .bat launcher — нужен потому, что Chrome вызывает путь из манифеста
// как исполняемый файл, а .js напрямую не запустится без ассоциации.
const LAUNCHER_CONTENT = `@echo off
REM NEZAR Native Messaging Host launcher (auto-generated)
"${NODE_BIN}" "${HOST_JS}"
`;

console.log('=== NEZAR Native Host installer (Windows) ===');
console.log('Extension ID: ' + EXTENSION_ID);
console.log('Node binary:  ' + NODE_BIN);
console.log('host.js:      ' + HOST_JS);
console.log('');

// 1. Создаём директорию и launcher
try {
  fs.mkdirSync(HOST_DIR, { recursive: true });
  fs.writeFileSync(LAUNCHER_PATH, LAUNCHER_CONTENT);
  console.log('[OK] Launcher written: ' + LAUNCHER_PATH);
} catch (e) {
  console.error('[FAIL] Cannot write launcher: ' + e.message);
  process.exit(1);
}

// 2. Пишем манифест
const manifestContent = JSON.stringify({
  name: 'com.nezar.host',
  description: 'NEZAR Native Messaging Host — bridge between browser extension and OS terminal',
  path: LAUNCHER_PATH,
  type: 'stdio',
  allowed_origins: [
    `chrome-extension://${EXTENSION_ID}/`,
  ],
}, null, 2);

try {
  fs.writeFileSync(MANIFEST_PATH, manifestContent);
  console.log('[OK] Manifest written: ' + MANIFEST_PATH);
} catch (e) {
  console.error('[FAIL] Cannot write manifest: ' + e.message);
  process.exit(1);
}

// 3. Регистрируем в реестре — Chrome и Edge
//    HKCU\Software\Google\Chrome\NativeMessagingHosts\com.nezar.host = путь к манифесту
const REG_KEYS = [
  {
    name: 'Google Chrome',
    key: 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.nezar.host',
  },
  {
    name: 'Microsoft Edge',
    key: 'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\com.nezar.host',
  },
  {
    name: 'Brave',
    key: 'HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\com.nezar.host',
  },
];

for (const target of REG_KEYS) {
  try {
    // reg add <key> /ve /d "<manifestPath>" /f
    const cmd = `reg add "${target.key}" /ve /d "${MANIFEST_PATH}" /f`;
    execSync(cmd, { stdio: 'pipe' });
    console.log('[OK] Registry: ' + target.name);
  } catch (e) {
    console.error('[SKIP] Registry ' + target.name + ': ' + e.message);
  }
}

console.log('');
console.log('=== Installation complete ===');
console.log('Restart your browser, then reload the NEZAR extension.');
console.log('Native host directory: ' + HOST_DIR);
