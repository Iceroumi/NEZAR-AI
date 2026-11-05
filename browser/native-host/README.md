# NEZAR Native Messaging Host

Связь браузерного расширения NEZAR с ОС-терминалом **без VSCode** через протокол Chrome Native Messaging.

## Что это даёт

- Команды из Blockly-блока `терминал native` выполняются прямо в ОС
- Захват stdout/stderr + exit code гарантирован
- Не нужен Firebase, не нужен открытый VSCode
- Кросс-платформенно: Windows / macOS / Linux

## Структура

```
native-host/
├── host.js                  # сам native host (Node.js, читает stdin, пишет в stdout)
├── com.nezar.host.json      # шаблон манифеста native messaging
├── install-macos.js         # установка на macOS (Chrome/Edge/Brave)
├── install-linux.js         # установка на Linux (Chrome/Chromium/Edge/Brave/Vivaldi)
├── install-windows.js       # установка на Windows (Chrome/Edge/Brave через реестр HKCU)
└── test-host.js             # локальный тест протокола без браузера
```

## Установка

### 1. Узнать Extension ID

1. Открой `chrome://extensions/` (или `edge://extensions/`)
2. Включи **Developer mode** (правый верхний угол)
3. Загрузи NEZAR browser-extension (unpacked)
4. Скопируй ID расширения (32 символа, например `abcdefghijklmnopqrstuvwxyzabcdef`)

### 2. Установить native host

**macOS:**
```bash
cd native-host
node install-macos.js abcdefghijklmnopqrstuvwxyzabcdef
# (если /usr/local/bin недоступен для записи — sudo)
sudo node install-macos.js abcdefghijklmnopqrstuvwxyzabcdef
```

**Linux:**
```bash
cd native-host
node install-linux.js abcdefghijklmnopqrstuvwxyzabcdef
```

**Windows (cmd или PowerShell):**
```cmd
cd native-host
node install-windows.js abcdefghijklmnopqrstuvwxyzabcdef
```

Скрипт сделает:
- создаст launcher-скрипт (`.sh` на unix, `.bat` на windows), который запускает `host.js` через Node
- положит манифест `com.nezar.host.json` в стандартное место (или зарегистрирует в реестре на Windows)
- пропишет `allowed_origins` с твоим Extension ID

### 3. Перезапустить браузер

Полностью закрой Chrome/Edge и открой заново. Native messaging host подхватывается только при старте.

### 4. Проверить

В NEZAR dashboard открой DevTools (F12), в консоли:
```js
chrome.runtime.sendMessage({ action: 'native_ping' }, r => console.log(r));
```

Должно вывести `{ ok: true, info: { type: 'pong', version: '0.1.0', platform: 'linux' ... } }`.

Если ошибка `Native host disconnected` — проверь:
- ID расширения правильно прописан в `allowed_origins`
- Launcher-скрипт существует и исполняемый (`ls -la /usr/local/bin/nezar-host.sh`)
- Путь к Node правильный в launcher-скрипте (`which node`)

## Использование в Blockly

В категории **Действия** появился блок:

```
терминал native [TEXT] папка [CWD] вывод в [VAR]
```

- `TEXT` — команда для выполнения (например `npm run build`)
- `CWD` — рабочая директория (опционально; можно блок «текст» вставить с путём)
- `VAR` — переменная Blockly, в которую запишется вывод (stdout + stderr)

Пример: `терминал native [текст "git status"] папка [текст "/home/z/my-project"] вывод в [переменная result]`

Затем блок `вывести в чат [переменная result]` покажет результат.

## Протокол обмена

**Browser → Host** (через `chrome.runtime.connectNative`):
```json
{ "id": "req_123", "command": "echo hello", "cwd": "/path", "timeout": 60000 }
```

**Host → Browser** (стрим):
```json
{ "id": "req_123", "type": "stdout", "text": "hello\n" }
{ "id": "req_123", "type": "stderr", "text": "warning...\n" }
{ "id": "req_123", "type": "done", "exitCode": 0, "stdout": "hello\n", "stderr": "" }
```

На ошибку:
```json
{ "id": "req_123", "type": "error", "error": "Timeout after 60000ms", "stdout": "...", "stderr": "..." }
```

Проверка связи:
```json
→ { "id": "x", "type": "ping" }
← { "id": "x", "type": "pong", "version": "0.1.0", "platform": "linux", "node": "v24.22.2", ... }
```

## Безопасность

- `allowed_origins` в манифесте ограничивает только конкретным Extension ID — чужие расширения не смогут подключиться
- Браузер сам просит пользователя разрешить доступ к native host при первом вызове (prompt)
- stderr не виден браузером — для логов (journalctl на Linux, Console.app на macOS, Event Viewer на Windows)

## Тест без браузера

```bash
cd native-host
node test-host.js
```

Проверит ping, echo, ls с cwd, обработку ошибок, sleep. Должно вывести `5 passed, 0 failed`.

## Удаление

**macOS/Linux:**
```bash
rm -f /usr/local/bin/nezar-host.sh ~/.local/bin/nezar-host.sh
rm -f ~/.config/google-chrome/NativeMessagingHosts/com.nezar.host.json
rm -f ~/.config/microsoft-edge/NativeMessagingHosts/com.nezar.host.json
rm -f ~/Library/Application\ Support/Google/Chrome/NativeMessagingHosts/com.nezar.host.json
```

**Windows (PowerShell):**
```powershell
Remove-Item $env:USERPROFILE\nezar-host -Recurse -Force
reg delete "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.nezar.host" /f
reg delete "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.nezar.host" /f
```
