# NEZAR AI — Native Messaging Host

Связь браузерного расширения NEZAR с ОС-терминалом **без VSCode** через Chrome Native Messaging.

## Быстрая установка (одной командой)

После распаковки `NEZAR_AI.zip`:

**Linux/macOS:**
```bash
cd NEZAR_AI/native-host
./install.sh
```

**Windows (PowerShell):**
```powershell
cd NEZAR_AI\native-host
.\install.ps1
```

Скрипт сам:
- определит ОС
- спросит Extension ID (или возьмёт из аргумента: `./install.sh dknofjkomgdkafpokoppfgpiohfbdnml`)
- зарегистрирует native host во всех браузерах (Chrome, Edge, Brave, Chromium, Vivaldi)
- установит CLI-команду `nezar` в `~/.local/bin` (или `/usr/local/bin` на macOS)
- запустит тест (5 проверок)

## CLI-команда `nezar`

После установки доступны глобальные команды:

```bash
nezar status      # показать статус (манифесты, launcher, Extension ID)
nezar test        # запустить 5 локальных тестов
nezar ping        # инструкция как проверить через Chrome DevTools
nezar reinstall   # переустановить (запросит Extension ID)
nezar uninstall   # удалить native host полностью
nezar help        # все команды
```

## Ручная установка (если нет install.sh)

Если по какой-то причине `install.sh` не работает — запусти напрямую:

```bash
# Linux
node install-linux.js <extension_id>

# macOS
node install-macos.js <extension_id>

# Windows (cmd/PowerShell)
node install-windows.js <extension_id>
```

## Пошаговая установка

### 1. Загрузить расширение в Chrome

1. Открой `chrome://extensions/`
2. Включи **Developer mode** (правый верх)
3. **Load unpacked** → выбери папку `browser-extension` (из `NEZAR_AI.zip`)
4. Скопируй **ID** расширения (32 буквы, например `abcdefghijklmnopqrstuvwxyzabcdef`)

### 2. Запустить установщик

```bash
cd NEZAR_AI/native-host
./install.sh
# скрипт попросит Extension ID — вставь скопированный
```

Если нужно явно указать ID:
```bash
./install.sh abcdefghijklmnopqrstuvwxyzabcdef
```

### 3. Перезапустить браузер

**Полностью закрой Chrome** (Cmd+Q на macOS, все окна на Windows/Linux) и открой заново.

### 4. Проверить

```bash
nezar ping
```

Или вручную: открой NEZAR dashboard → F12 → Console → вставь:
```js
chrome.runtime.sendMessage({ action: 'native_ping' }, r => console.log(r));
```

**Успех:**
```js
{ ok: true, info: { type: 'pong', version: '0.1.0', platform: 'linux', node: '...', homedir: '/home/user' } }
```

## Использование в Blockly

В категории **Действия** есть блок:

```
терминал native [TEXT] папка [CWD] вывод в [VAR]
```

Пример: `терминал native [текст "echo hi"] папка [текст "/home/user"] вывод в [переменная result]`
Дальше: блок `вывести в чат [переменная result]` → в чате появится `hi`.

## Структура

```
native-host/
├── install.sh              ← главный установщик (Linux/macOS) — запусти это
├── install.ps1             ← главный установщик (Windows PowerShell)
├── nezar-cli.sh            ← CLI (устанавливается как `nezar`)
├── host.js                 ← сам native host (Node.js, stdin/stdout протокол)
├── com.nezar.host.json     ← шаблон манифеста
├── install-linux.js        ← установка для Linux (вызывается из install.sh)
├── install-macos.js        ← установка для macOS
├── install-windows.js      ← установка для Windows (реестр HKCU)
├── test-host.js            ← локальный тест (5 проверок)
└── README.md               ← этот файл
```

## Устранение проблем

### Snap-версия Node.js (Linux)

Если Node установлен через snap (`/snap/node/x1/bin/node`), он может не видеть скрипты вне `$HOME`. Симптом: `nezar status` показывает манифест на месте, но ping в Chrome даёт `Native host disconnected`.

**Решение:** перенеси NEZAR_AI в `$HOME`:
```bash
mv /opt/.../NEZAR-AI ~/NEZAR-AI
cd ~/NEZAR-AI/native-host
./install.sh dknofjkomgdkafpokoppfgpiohfbdnml
```

Или установи Node через nvm (не snap):
```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.bashrc
nvm install 22
```

### CLI `nezar` не работает после установки

Если `nezar: command not found`:
```bash
# Проверь что ~/.local/bin в PATH:
echo $PATH | tr ':' '\n' | grep local/bin

# Если нет — добавь:
echo 'export PATH=$HOME/.local/bin:$PATH' >> ~/.bashrc
source ~/.bashrc
```

### Запусти диагностику

```bash
nezar status    # что установлено
nezar test      # работает ли host
```

Пришли вывод этих команд + результат ping из Chrome DevTools — разберёмся.

## Удаление

```bash
nezar uninstall
```

Это удалит:
- launcher `~/.local/bin/nezar-host.sh`
- манифесты из всех браузеров (`~/.config/*/NativeMessagingHosts/com.nezar.host.json`)
- сам CLI `~/.local/bin/nezar`

После удаления перезапусти Chrome.

## Протокол обмена

**Browser → Host** (`chrome.runtime.connectNative`):
```json
{ "id": "req_123", "command": "echo hello", "cwd": "/path", "timeout": 60000 }
```

**Host → Browser** (стрим):
```json
{ "id": "req_123", "type": "stdout", "text": "hello\n" }
{ "id": "req_123", "type": "stderr", "text": "..." }
{ "id": "req_123", "type": "done", "exitCode": 0, "stdout": "hello\n", "stderr": "" }
```

Ping:
```json
→ { "id": "x", "type": "ping" }
← { "id": "x", "type": "pong", "version": "0.1.0", "platform": "linux", ... }
```

## Безопасность

- `allowed_origins` в манифесте ограничивает доступ только твоим Extension ID
- Браузер сам запрашивает разрешение при первом вызове
- stderr не виден браузером — для логов (journalctl на Linux, Console.app на macOS, Event Viewer на Windows)
