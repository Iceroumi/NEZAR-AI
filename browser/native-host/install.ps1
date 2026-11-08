# ============================================================
#  NEZAR AI — Windows Installer (PowerShell)
#  Запуск в PowerShell:
#    .\install.ps1
#  Или с указанием Extension ID:
#    .\install.ps1 dknofjkomgdkafpokoppfgpiohfbdnml
# ============================================================

$ErrorActionPreference = "Stop"

function Print-Ok   { param($msg) Write-Host "[OK] $msg" -ForegroundColor Green }
function Print-Info { param($msg) Write-Host "[i] $msg" -ForegroundColor Cyan }
function Print-Warn { param($msg) Write-Host "[!] $msg" -ForegroundColor Yellow }
function Print-Err  { param($msg) Write-Host "[ERR] $msg" -ForegroundColor Red }
function Print-Step { param($msg) Write-Host "`n=== $msg ===" -ForegroundColor Blue }

Write-Host @"
 _   _ ___ _   _ ___    ___  ___
| \ | | __| | | | _ \  | _ \/ __|
|  \| | _|| |_| |   /  |  _/ (__
|_|\_|___|\___/|_|_\  |_|  \___|
              AI Installer v1.0
"@ -ForegroundColor Cyan

# --- Шаг 1: ОС ---
Print-Step "Шаг 1: определение ОС"
Print-Ok "OS: Windows"

# --- Шаг 2: Node ---
Print-Step "Шаг 2: проверка Node.js"
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Print-Err "Node.js не найден в PATH"
    Print-Info "Установи Node.js: https://nodejs.org/"
    exit 1
}
$nodeBin = $nodeCmd.Source
$nodeVer = & node --version
Print-Ok "Node: $nodeBin ($nodeVer)"

# --- Шаг 3: путь к native-host ---
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$hostJs = Join-Path $ScriptDir "host.js"
if (-not (Test-Path $hostJs)) {
    Print-Err "host.js не найден рядом с install.ps1"
    Print-Info "Ожидаю в: $hostJs"
    exit 1
}
Print-Ok "host.js: $hostJs"

# --- Шаг 4: Extension ID ---
Print-Step "Шаг 4: Extension ID"
$extensionId = $args[0]
if (-not $extensionId) {
    Write-Host ""
    Print-Info "Как найти Extension ID:"
    Write-Host "  1. Открой chrome://extensions/ в Chrome"
    Write-Host "  2. Включи Developer mode (правый верх)"
    Write-Host "  3. Найди карточку NEZAR AI"
    Write-Host "  4. Скопируй ID (32 буквы)"
    Write-Host ""
    $extensionId = Read-Host "Вставь Extension ID"
}

if (-not $extensionId) {
    Print-Err "Extension ID не указан"
    exit 1
}

if ($extensionId -notmatch '^[a-p]{32}$') {
    Print-Err "Неверный формат Extension ID: '$extensionId'"
    Print-Info "Должен быть 32 символа, только буквы a-p"
    exit 1
}
Print-Ok "Extension ID: $extensionId"

# --- Шаг 5: запуск install-windows.js ---
Print-Step "Шаг 5: регистрация native host"
Print-Info "Запускаю install-windows.js..."
& node (Join-Path $ScriptDir "install-windows.js") $extensionId
if ($LASTEXITCODE -ne 0) {
    Print-Err "Установка завершилась с ошибкой"
    exit $LASTEXITCODE
}

# --- Шаг 6: тест ---
Print-Step "Шаг 6: тест native host"
$testHost = Join-Path $ScriptDir "test-host.js"
if (Test-Path $testHost) {
    Print-Info "Запускаю test-host.js..."
    & node $testHost 2>&1 | Select-Object -Last 5
    if ($LASTEXITCODE -eq 0) {
        Print-Ok "Все тесты прошли"
    }
}

# --- Итог ---
Print-Step "Готово!"
Write-Host ""
Print-Ok "Native host установлен и зарегистрирован"
Write-Host ""
Print-Info "Следующий шаг:" -ForegroundColor Yellow
Write-Host "  1. Полностью закрой Chrome (все окна) и открой заново"
Write-Host "  2. Открой NEZAR dashboard (клик по иконке расширения)"
Write-Host "  3. Нажми F12 -> Console -> вставь:"
Write-Host ""
Write-Host "     chrome.runtime.sendMessage({ action: 'native_ping' }, r => console.log(r));" -ForegroundColor Green
Write-Host ""
Write-Host "  4. Должно вывести: { ok: true, info: { type: 'pong', ... } }"
Write-Host ""
