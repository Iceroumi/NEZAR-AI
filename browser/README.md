# NEZAR — визуальный AI-агент

Бесплатное браузерное расширение: **Blockly-блоки + web-чаты AI + терминал ОС**.
Без API-ключей, без облака, без Firebase.

## Что внутри

- **manifest.json** — Manifest V3, разрешения: `storage`, `tabs`, `nativeMessaging`. Никаких firebaseio.com в host_permissions.
- **dashboard.html** — одностраничный dashboard: сайдбар со списком проектов + чат + панель Blockly (видна по умолчанию).
- **dashboard.js** — логика проекта (per-project isolation через IndexedDB), отправка в терминал через `chrome.runtime.sendMessage({action:'native_run'})`.
- **blockly.js** — Blockly-блоки: промпт, текст, join, запросы к DeepSeek/Qwen, native-терминал, навыки, вывод, ожидание, переменные, логика, циклы.
- **background.js** — service worker: открывает dashboard, маршрутизирует сообщения AI-вкладок, вызывает native host.
- **content/main.js** — content script для chat.deepseek.com / chat.qwen.ai / chat.z.ai / alice.yandex.ru.

## Per-project isolation

Каждый чат = отдельный проект со своими блоками:

- IndexedDB-хранилище `nezar-db` (store `projects`, версия 2).
- При переключении проекта: блоки старого сохраняются в его запись, блоки нового загружаются в workspace.
- Blockly инициализируется ЕДИНОВРЕМЕННО при загрузке dashboard (`initBlockly()` в `init()`), поэтому `selectProject()` всегда может очистить и загрузить блоки.
- Защита от гонок: `editorState.isLoading` блокирует автосохранение во время программной загрузки.
- Автосохранение: debounce 1 сек → memory, 5 сек → IndexedDB.

## Терминал (Native Messaging)

Никакого Firebase. Команды идут напрямую в ОС через Chrome Native Messaging:

```
dashboard.js  →  chrome.runtime.sendMessage({action:'native_run', command, cwd, timeout})
                       ↓
background.js  →  chrome.runtime.connectNative('com.nezar.host')
                       ↓
native host (Node.js)  →  spawn(command, {cwd, shell:true})
                       ↓
{ ok, stdout, stderr, exitCode }  →  обратно в dashboard
```

Native host должен быть установлен: см. `_source/native-host/install.sh`.

## Установка расширения

1. Скачать `nezar-extension-clean/`.
2. Chrome: `chrome://extensions` → Developer mode → Load unpacked → выбрать папку.
3. Установить native host (иначе терминал не работает, но AI и блоки — работают).

## Блоки

| Категория | Блоки |
|---|---|
| Промпт | `ПРОМПТ`, `текст`, `+` (concat) |
| Действия | `запрос к deepseek`, `запрос к qwen`, `запрос к алисе`, `терминал native`, `вывести в чат` |
| Навыки | `навык`, `вызов скила` |
| Переменные | (стандартные Blockly) |
| Логика | `if`, `=`, `AND/OR`, `NOT`, `true/false` |
| Циклы | `repeat N`, `while/until`, `wait N sec` |

## Поддерживаемые AI-чаты

| Сайт | URL | Блок |
|---|---|---|
| DeepSeek | https://chat.deepseek.com | `запрос к deepseek` |
| Qwen | https://chat.qwen.ai | `запрос к qwen` |
| Яндекс Алиса | https://alice.yandex.ru | `запрос к алисе` |
| GLM (z.ai) | https://chat.z.ai | (через `запрос к deepseek` с подменой URL) |
