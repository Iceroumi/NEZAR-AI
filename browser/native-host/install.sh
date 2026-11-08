#!/usr/bin/env bash
# ============================================================
#  NEZAR AI — Unified Installer
#  Запуск:
#    ./install.sh
#  Или с указанием Extension ID:
#    ./install.sh dknofjkomgdkafpokoppfgpiohfbdnml
# ============================================================
set -e

# --- Цвета ---
RED=$'\033[0;31m'
GREEN=$'\033[0;32m'
YELLOW=$'\033[1;33m'
CYAN=$'\033[0;36m'
BLUE=$'\033[0;34m'
NC=$'\033[0m'

print_ok()   { echo -e "${GREEN}[OK]${NC} $1"; }
print_info() { echo -e "${CYAN}[i]${NC} $1"; }
print_warn() { echo -e "${YELLOW}[!]${NC} $1"; }
print_err()  { echo -e "${RED}[ERR]${NC} $1"; }
print_step() { echo -e "\n${BLUE}=== $1 ===${NC}"; }

# --- Баннер ---
echo -e "${CYAN}"
cat << 'BANNER'
 _   _ ___ _   _ ___    ___  ___
| \ | | __| | | | _ \  | _ \/ __|
|  \| | _|| |_| |   /  |  _/ (__
|_|\_|___|\___/|_|_\  |_|  \___|
              AI Installer v1.0
BANNER
echo -e "${NC}"

# --- Определение ОС ---
print_step "Шаг 1: определение ОС"
OS="unknown"
case "$(uname -s)" in
  Linux*)  OS="linux";;
  Darwin*) OS="macos";;
  MING*|MSYS*|CYGWIN*) OS="windows";;
  *) OS="unknown";;
esac
ARCH="$(uname -m)"
print_ok "OS: $OS ($ARCH)"

if [ "$OS" = "unknown" ]; then
  print_err "Неизвестная ОС: $(uname -s)"
  print_info "Поддерживаются: Linux, macOS, Windows (Git Bash/WSL)"
  exit 1
fi

# --- Проверка Node ---
print_step "Шаг 2: проверка Node.js"
if ! command -v node >/dev/null 2>&1; then
  print_err "Node.js не найден в PATH"
  print_info "Установи Node.js: https://nodejs.org/ или через nvm"
  exit 1
fi
NODE_BIN="$(command -v node)"
NODE_VER="$(node --version)"
print_ok "Node: $NODE_BIN ($NODE_VER)"

# --- Проверка snap-node ---
if [[ "$NODE_BIN" == /snap/node/* ]]; then
  print_warn "У тебя Node установлен через snap ($NODE_BIN)"
  print_warn "Snap-пакеты имеют ограничения по доступу к файловой системе."
  print_warn "Если host.js лежит вне \$HOME — snap-node не сможет его прочитать."
  print_warn "Рекомендация: перенести NEZAR_AI в \$HOME перед установкой."
  echo ""
  read -p "Продолжить всё равно? [y/N]: " CONT
  if [[ ! "$CONT" =~ ^[Yy]$ ]]; then
    print_info "Перенеси папку: mv /opt/.../NEZAR-AI ~/NEZAR_AI и запусти ./install.sh оттуда"
    exit 0
  fi
fi

# --- Путь к native-host ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_JS="$SCRIPT_DIR/host.js"

if [ ! -f "$HOST_JS" ]; then
  print_err "host.js не найден рядом с install.sh"
  print_info "Ищу в: $HOST_JS"
  print_info "Запусти этот скрипт из папки native-host/"
  exit 1
fi
print_ok "host.js: $HOST_JS"

# --- Extension ID ---
print_step "Шаг 3: Extension ID"
EXTENSION_ID="$1"
if [ -z "$EXTENSION_ID" ]; then
  echo ""
  print_info "Как найти Extension ID:"
  echo "  1. Открой chrome://extensions/ в Chrome"
  echo "  2. Включи Developer mode (правый верх)"
  echo "  3. Найди карточку NEZAR AI"
  echo "  4. Скопируй ID (32 буквы, например abcdef...)"
  echo ""
  read -p "Вставь Extension ID: " EXTENSION_ID
fi

if [ -z "$EXTENSION_ID" ]; then
  print_err "Extension ID не указан"
  exit 1
fi

# Валидация формата (32 латинских буквы a-p)
if [[ ! "$EXTENSION_ID" =~ ^[a-p]{32}$ ]]; then
  print_err "Неверный формат Extension ID: '$EXTENSION_ID'"
  print_info "Должен быть 32 символа, только буквы a-p"
  exit 1
fi
print_ok "Extension ID: $EXTENSION_ID"

# --- Запуск установщика ОС ---
print_step "Шаг 4: регистрация native host"
case "$OS" in
  linux)
    print_info "Запускаю install-linux.js..."
    node "$SCRIPT_DIR/install-linux.js" "$EXTENSION_ID"
    ;;
  macos)
    print_info "Запускаю install-macos.js..."
    if [ ! -w /usr/local/bin ] 2>/dev/null; then
      print_warn "/usr/local/bin недоступен для записи — запускаю через sudo"
      sudo node "$SCRIPT_DIR/install-macos.js" "$EXTENSION_ID"
    else
      node "$SCRIPT_DIR/install-macos.js" "$EXTENSION_ID"
    fi
    ;;
  windows)
    print_info "Запускаю install-windows.js..."
    node "$SCRIPT_DIR/install-windows.js" "$EXTENSION_ID"
    ;;
esac

INSTALL_STATUS=$?
if [ $INSTALL_STATUS -ne 0 ]; then
  print_err "Установка завершилась с ошибкой (код $INSTALL_STATUS)"
  exit $INSTALL_STATUS
fi

# --- Установка CLI-команды nezar ---
print_step "Шаг 5: установка CLI-команды 'nezar'"
CLI_SRC="$SCRIPT_DIR/nezar-cli.sh"
CLI_DEST=""
case "$OS" in
  linux)
    mkdir -p "$HOME/.local/bin"
    CLI_DEST="$HOME/.local/bin/nezar"
    cp "$CLI_SRC" "$CLI_DEST"
    chmod +x "$CLI_DEST"
    ;;
  macos)
    CLI_DEST="/usr/local/bin/nezar"
    if [ -w /usr/local/bin ] 2>/dev/null; then
      cp "$CLI_SRC" "$CLI_DEST"
      chmod +x "$CLI_DEST"
    else
      sudo cp "$CLI_SRC" "$CLI_DEST"
      sudo chmod +x "$CLI_DEST"
    fi
    ;;
esac

if [ -n "$CLI_DEST" ] && [ -f "$CLI_DEST" ]; then
  print_ok "CLI установлен: $CLI_DEST"
  # Проверим, что в PATH
  if command -v nezar >/dev/null 2>&1; then
    print_ok "Команда 'nezar' доступна глобально"
  else
    print_warn "Папка $HOME/.local/bin не в PATH"
    print_info "Добавь в ~/.bashrc:"
    echo "    export PATH=\$HOME/.local/bin:\$PATH"
    print_info "Или запусти напрямую: $CLI_DEST <команда>"
  fi
else
  print_warn "CLI не установлен (только Windows или другая ОС)"
fi

# --- Локальный тест ---
print_step "Шаг 6: тест native host"
if [ -f "$SCRIPT_DIR/test-host.js" ]; then
  print_info "Запускаю test-host.js (5 тестов)..."
  if node "$SCRIPT_DIR/test-host.js" 2>&1 | tail -3; then
    print_ok "Все тесты прошли"
  else
    print_warn "Тесты упали — посмотри вывод выше"
  fi
fi

# --- Итог ---
print_step "Готово!"
echo ""
print_ok "Native host установлен и зарегистрирован"
print_ok "CLI команда: ${CYAN}nezar${NC} (доступна глобально)"
echo ""
print_info "${YELLOW}Следующий шаг:${NC}"
echo "  1. ${CYAN}Полностью${NC} закрой Chrome (все окна) и открой заново"
echo "  2. Открой NEZAR dashboard (клик по иконке расширения)"
echo "  3. Нажми F12 → Console → вставь:"
echo ""
echo "     ${GREEN}chrome.runtime.sendMessage({ action: 'native_ping' }, r => console.log(r));${NC}"
echo ""
echo "  4. Должно вывести: { ok: true, info: { type: 'pong', ... } }"
echo ""
print_info "Команды CLI:"
echo "  ${CYAN}nezar status${NC}    — проверить установку"
echo "  ${CYAN}nezar test${NC}      — запустить тесты"
echo "  ${CYAN}nezar uninstall${NC} — удалить native host"
echo "  ${CYAN}nezar help${NC}      — все команды"
echo ""
