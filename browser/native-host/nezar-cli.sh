#!/usr/bin/env bash
# ============================================================
#  NEZAR CLI — управление установленным native host
#  Команды:
#    nezar status     — показать статус установки
#    nezar test       — запустить локальный тест host
#    nezar ping       — инструкция для проверки через Chrome DevTools
#    nezar uninstall  — удалить native host
#    nezar reinstall  — переустановить (запросит Extension ID)
#    nezar help       — показать все команды
# ============================================================

# Цвета
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

# Где лежат файлы native-host (рядом с этим скриптом в исходной папке)
SCRIPT_PATH="$(readlink -f "$0" 2>/dev/null || echo "$0")"
SCRIPT_DIR="$(dirname "$SCRIPT_PATH")"

# В реальной установке nezar-cli.sh лежит в ~/.local/bin/nezar
# а host.js с файлами — в исходной папке. Найти её:
find_host_dir() {
  # Сначала пробуем переменную окружения NEZAR_HOST_DIR
  if [ -n "$NEZAR_HOST_DIR" ] && [ -f "$NEZAR_HOST_DIR/host.js" ]; then
    echo "$NEZAR_HOST_DIR"
    return
  fi
  # Пробуем стандартные пути
  for candidate in \
    "$HOME/nezar-native-host" \
    "$HOME/NEZAR_AI/native-host" \
    "$HOME/NEZAR-AI/browser/native-host" \
    "$HOME/NEZAR-AI/native-host" \
    "/usr/local/share/nezar/native-host" \
    "$SCRIPT_DIR/.." \
    "$SCRIPT_DIR"
  do
    if [ -f "$candidate/host.js" ]; then
      echo "$candidate"
      return
    fi
  done
  # Если ничего не нашли — пусть пользователь сам укажет
  echo ""
}

HOST_DIR="$(find_host_dir)"

# Определение ОС
detect_os() {
  case "$(uname -s)" in
    Linux*)  echo "linux";;
    Darwin*) echo "macos";;
    MING*|MSYS*|CYGWIN*) echo "windows";;
    *) echo "unknown";;
  esac
}

# ============================================================
# Команды
# ============================================================

cmd_help() {
  cat << EOF
${BLUE}NEZAR CLI${NC} — управление native host

${CYAN}Команды:${NC}
  ${GREEN}nezar status${NC}     — показать статус установки (манифест, launcher, ID)
  ${GREEN}nezar test${NC}       — запустить локальный тест host.js (5 тестов)
  ${GREEN}nezar ping${NC}       — инструкция для проверки через Chrome DevTools
  ${GREEN}nezar reinstall${NC}  — переустановить (запросит Extension ID)
  ${GREEN}nezar uninstall${NC}  — удалить native host из системы
  ${GREEN}nezar help${NC}       — показать эту справку

${CYAN}Переменные окружения:${NC}
  NEZAR_HOST_DIR=/path/to/native-host  — указать папку с host.js

${CYAN}Примеры:${NC}
  nezar status
  nezar test
  nezar uninstall
EOF
}

cmd_status() {
  echo -e "${BLUE}=== NEZAR Status ===${NC}\n"

  local os=$(detect_os)
  print_ok "OS: $os"

  # Node
  if command -v node >/dev/null 2>&1; then
    print_ok "Node: $(command -v node) ($(node --version))"
  else
    print_err "Node: не найден"
  fi

  # Launcher script
  local launchers=()
  case "$os" in
    linux)  launchers=("$HOME/.local/bin/nezar-host.sh");;
    macos)  launchers=("/usr/local/bin/nezar-host.sh");;
    windows) launchers=("$USERPROFILE/nezar-host/nezar-host.bat" "$HOME/nezar-host/nezar-host.bat");;
  esac

  echo ""
  echo -e "${BLUE}Launcher:${NC}"
  local found_launcher=""
  for l in "${launchers[@]}"; do
    if [ -f "$l" ]; then
      print_ok "  $l"
      found_launcher="$l"
    fi
  done
  if [ -z "$found_launcher" ]; then
    print_err "  launcher не найден"
  fi

  # Манифесты
  echo ""
  echo -e "${BLUE}Native Messaging manifests:${NC}"
  local manifest_dirs=()
  case "$os" in
    linux)
      manifest_dirs=(
        "$HOME/.config/google-chrome/NativeMessagingHosts"
        "$HOME/.config/chromium/NativeMessagingHosts"
        "$HOME/.config/microsoft-edge/NativeMessagingHosts"
        "$HOME/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts"
        "$HOME/.config/vivaldi/NativeMessagingHosts"
      )
      ;;
    macos)
      manifest_dirs=(
        "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
        "$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts"
        "$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts"
      )
      ;;
    windows)
      manifest_dirs=("$USERPROFILE/nezar-host" "$HOME/nezar-host")
      ;;
  esac

  local found_manifests=0
  for d in "${manifest_dirs[@]}"; do
    if [ -f "$d/com.nezar.host.json" ]; then
      print_ok "  $d/com.nezar.host.json"
      # Покажем extension_id
      local ext_id
      ext_id=$(grep -o '"chrome-extension://[^/]*' "$d/com.nezar.host.json" | sed 's/"chrome-extension:\/\///')
      if [ -n "$ext_id" ]; then
        echo -e "      Extension ID: ${CYAN}${ext_id}${NC}"
      fi
      found_manifests=$((found_manifests+1))
    fi
  done
  if [ $found_manifests -eq 0 ]; then
    print_err "  манифесты не найдены — native host не установлен"
  fi

  # host.js
  echo ""
  echo -e "${BLUE}host.js:${NC}"
  if [ -n "$HOST_DIR" ] && [ -f "$HOST_DIR/host.js" ]; then
    print_ok "  $HOST_DIR/host.js"
  else
    print_warn "  папка с host.js не найдена автоматически"
    print_info "  укажи через NEZAR_HOST_DIR=/path && nezar status"
  fi

  # Итог
  echo ""
  if [ -n "$found_launcher" ] && [ $found_manifests -gt 0 ]; then
    print_ok "Статус: УСТАНОВЛЕН"
  else
    print_err "Статус: НЕ УСТАНОВЛЕН"
    print_info "Запусти: ./install.sh <extension_id>"
  fi
}

cmd_test() {
  if [ -z "$HOST_DIR" ] || [ ! -f "$HOST_DIR/test-host.js" ]; then
    print_err "test-host.js не найден"
    print_info "Укажи папку: NEZAR_HOST_DIR=/path/to/native-host nezar test"
    return 1
  fi
  echo -e "${BLUE}=== Запуск теста ===${NC}\n"
  node "$HOST_DIR/test-host.js"
}

cmd_ping() {
  cat << EOF
${BLUE}=== Как проверить через Chrome DevTools ===${NC}

1. Открой NEZAR dashboard (клик по иконке расширения на панели Chrome)
2. Нажми ${GREEN}F12${NC} → вкладка ${GREEN}Console${NC}
3. Вставь эту строку и нажми Enter:

   ${CYAN}chrome.runtime.sendMessage({ action: 'native_ping' }, r => console.log(r));${NC}

${GREEN}Успех:${NC}
   { ok: true, info: { type: 'pong', version: '0.1.0', platform: '...', node: '...' } }

${RED}Провал:${NC}
   { ok: false, error: 'Native host disconnected...' }
   → проверь: ${CYAN}nezar status${NC}
   → перезапусти Chrome ПОЛНОСТЬЮ (закрой все окна)
EOF
}

cmd_uninstall() {
  echo -e "${RED}=== Удаление NEZAR native host ===${NC}\n"

  local os=$(detect_os)

  # Удаляем launcher
  local launchers=("$HOME/.local/bin/nezar-host.sh" "/usr/local/bin/nezar-host.sh")
  for l in "${launchers[@]}"; do
    if [ -f "$l" ]; then
      rm -f "$l"
      print_ok "Удалён launcher: $l"
    fi
  done

  # Удаляем манифесты
  local manifest_dirs=()
  case "$os" in
    linux)
      manifest_dirs=(
        "$HOME/.config/google-chrome/NativeMessagingHosts"
        "$HOME/.config/chromium/NativeMessagingHosts"
        "$HOME/.config/microsoft-edge/NativeMessagingHosts"
        "$HOME/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts"
        "$HOME/.config/vivaldi/NativeMessagingHosts"
      )
      ;;
    macos)
      manifest_dirs=(
        "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
        "$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts"
        "$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts"
      )
      ;;
  esac

  for d in "${manifest_dirs[@]}"; do
    if [ -f "$d/com.nezar.host.json" ]; then
      rm -f "$d/com.nezar.host.json"
      print_ok "Удалён манифест: $d/com.nezar.host.json"
    fi
  done

  # CLI
  local cli_paths=("$HOME/.local/bin/nezar" "/usr/local/bin/nezar")
  for p in "${cli_paths[@]}"; do
    if [ -f "$p" ]; then
      rm -f "$p"
      print_ok "Удалён CLI: $p"
    fi
  done

  echo ""
  print_ok "NEZAR полностью удалён"
  print_info "Перезапусти Chrome, чтобы он подхватил изменения"
}

cmd_reinstall() {
  if [ -z "$HOST_DIR" ] || [ ! -f "$HOST_DIR/install.sh" ]; then
    print_err "install.sh не найден"
    print_info "Запусти ./install.sh вручную из папки native-host/"
    return 1
  fi
  echo -e "${BLUE}=== Переустановка NEZAR ===${NC}\n"
  if [ $# -gt 0 ]; then
    bash "$HOST_DIR/install.sh" "$1"
  else
    bash "$HOST_DIR/install.sh"
  fi
}

# ============================================================
# Главная петля
# ============================================================

COMMAND="${1:-help}"
shift 2>/dev/null || true

case "$COMMAND" in
  status)     cmd_status;;
  test)       cmd_test;;
  ping)       cmd_ping;;
  uninstall|remove) cmd_uninstall;;
  reinstall|install) cmd_reinstall "$@";;
  help|--help|-h)    cmd_help;;
  version|--version|-v) echo "NEZAR CLI v1.0";;
  *) echo -e "${RED}Неизвестная команда: $COMMAND${NC}"; echo "Запусти 'nezar help' для списка команд"; exit 1;;
esac
