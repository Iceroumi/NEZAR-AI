/* ============================================================
 * dashboard.js — NEZAR dashboard logic (NO Firebase).
 *
 * Архитектура:
 *   - Проекты хранятся в IndexedDB (per-project isolation).
 *   - Каждый проект = отдельный чат со своими Blockly-блоками.
 *   - Терминал: через Native Messaging (chrome.runtime.sendMessage
 *     action:'native_run'). Никакого облака.
 *   - AI: web-чаты DeepSeek/Qwen/GLM через content scripts.
 * ============================================================ */

// ============================================================
// Состояние проектов (per-project isolation)
// ============================================================
let projects = [];           // все проекты из IndexedDB (отсортированы по updatedAt)
let activeProjectId = null;  // ID выбранного проекта
let activeProject = null;    // полный объект выбранного проекта

// AI-режим: промпт отправляется в DeepSeek/Qwen/GLM, ответ — в терминал.
let aiMode = false;
let aiTabStatus = { ok: false, site: '', error: 'не проверено' };

// Native host status
let nativeHostStatus = { ok: false, error: 'не проверено', info: null };

// DOM.
const navItems = document.querySelectorAll(".nav-item");
const views = {
  "new-project": document.getElementById("view-new-project"),
};

// New Project DOM.
const npPromptInput = document.getElementById("np-prompt");
const npSendBtn = document.getElementById("np-send-btn");
const npStatus = document.getElementById("np-status");

// Sidebar collapse/expand DOM.
const sidebarCollapseBtn = document.getElementById("sidebar-collapse-btn");
const sidebarExpandBtn = document.getElementById("sidebar-expand-btn");

// Projects DOM.
const newProjectBtn = document.getElementById("new-project-btn");
const projectsList = document.getElementById("projects-list");
const projectTitleInput = document.getElementById("project-title-input");
const projectHistoryEl = document.getElementById("project-history");
const projectHeader = document.getElementById("project-header");
const projectEmptyState = document.getElementById("project-empty-state");
const emptyStateCreateBtn = document.getElementById("empty-state-create-btn");

// AI mode DOM.
const aiToggleBtn = document.getElementById("ai-toggle");
const aiStatusEl = document.getElementById("ai-status");

// Sidebar footer / native host status.
const connStatusEl = document.getElementById("conn-status");
const reconnectBtn = document.getElementById("reconnect-btn");

// ============================================================
// Глобальный debug-listener — логирует ВСЕ сообщения в dashboard.
// ============================================================
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  console.log('[nezar-dash] GLOBAL MSG:', msg.action,
    'phase=' + (msg.phase || ''),
    'textLen=' + (msg.text || '').length,
    'fromTab=' + (sender.tab?.id || 'N/A'));
  return false;
});

// ============================================================
// IndexedDB — хранилище проектов
// ============================================================
const DB_NAME = "nezar-db";
const DB_VERSION = 2;  // bumped: мигрируем со старой firebase-bridge-db
const STORE_PROJECTS = "projects";

function openDB() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB недоступен в этом окружении"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_PROJECTS)) {
        const store = db.createObjectStore(STORE_PROJECTS, { keyPath: "id" });
        store.createIndex("updatedAt", "updatedAt", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Создаёт новый проект с дефолтным именем.
async function dbCreateProject(name) {
  const db = await openDB();
  const project = {
    id: "proj_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8),
    name: name || "Новый проект",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    history: [],
    blocklyWorkspace: '',     // сериализованные блоки (JSON)
    blocklyVariables: {},     // runtime значения переменных
    blocklySkills: {},        // определённые навыки
    blocklyPromptText: '',
    editorStateSnapshot: '',
  };
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PROJECTS, "readwrite");
    tx.objectStore(STORE_PROJECTS).add(project);
    tx.oncomplete = () => resolve(project);
    tx.onerror = () => reject(tx.error);
  });
}

// Возвращает все проекты, отсортированные по updatedAt (новые сверху).
async function dbGetAllProjects() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PROJECTS, "readonly");
    const req = tx.objectStore(STORE_PROJECTS).getAll();
    req.onsuccess = () => {
      const list = req.result || [];
      list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      resolve(list);
    };
    req.onerror = () => reject(req.error);
  });
}

async function dbGetProject(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PROJECTS, "readonly");
    const req = tx.objectStore(STORE_PROJECTS).get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Обновляет проект. Ставит новый updatedAt.
async function dbUpdateProject(project) {
  const db = await openDB();
  project.updatedAt = Date.now();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PROJECTS, "readwrite");
    tx.objectStore(STORE_PROJECTS).put(project);
    tx.oncomplete = () => resolve(project);
    tx.onerror = () => reject(tx.error);
  });
}

async function dbDeleteProject(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PROJECTS, "readwrite");
    tx.objectStore(STORE_PROJECTS).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ============================================================
// UI helpers
// ============================================================
function setNpStatus(message, kind) {
  npStatus.textContent = message;
  npStatus.className = "np-status" + (kind ? " " + kind : "");
}
function clearNpStatus() {
  npStatus.textContent = "";
  npStatus.className = "np-status";
}

function formatTime(ts) {
  const d = new Date(ts);
  const pad = (n) => (n < 10 ? "0" + n : "" + n);
  return pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function switchView(name) {
  Object.keys(views).forEach((key) => {
    if (key === name) {
      views[key].classList.add("active");
    } else {
      views[key].classList.remove("active");
    }
  });
  navItems.forEach((item) => {
    if (item.getAttribute("data-view") === name) {
      item.classList.add("active");
    } else {
      item.classList.remove("active");
    }
  });
}

// ============================================================
// Управление проектами (IndexedDB + sidebar + view)
// ============================================================

async function loadProjects() {
  try {
    projects = await dbGetAllProjects();
  } catch (err) {
    console.error("[projects] loadProjects:", err);
    projects = [];
  }
  renderProjectsList();
}

// Создаёт новый проект, добавляет в список и делает активным.
async function createNewProject() {
  let name = "Новый проект";
  let n = 1;
  const existing = projects.map((p) => p.name);
  while (existing.indexOf(name) !== -1) {
    n += 1;
    name = "Новый проект " + n;
  }

  let project;
  try {
    project = await dbCreateProject(name);
  } catch (err) {
    setNpStatus("Не удалось создать проект: " + err.message, "err");
    return;
  }

  projects.unshift(project);
  renderProjectsList();
  await selectProject(project.id);
}

// Выбор проекта: сохраняет блоки предыдущего, загружает блоки нового.
async function selectProject(id) {
  const project = projects.find((p) => p.id === id);
  if (!project) return;

  // Подтягиваем полный объект из БД (на случай если в кеше только метаданные)
  if (!project.history || project.history.length === undefined) {
    try {
      const fresh = await dbGetProject(id);
      if (fresh) {
        const idx = projects.findIndex((p) => p.id === id);
        if (idx !== -1) projects[idx] = fresh;
      }
    } catch (err) {
      console.error("[projects] selectProject load:", err);
    }
  }

  // ⚠️ ВАЖНО: сначала СОХРАНЯЕМ блоки СТАРОГО activeProject,
  // потом переключаемся на новый, потом загружаем его блоки.
  const prevProject = activeProject;
  if (prevProject && prevProject.id !== id) {
    if (typeof saveBlocklyState === 'function') {
      saveBlocklyState(); // сохранит workspace (старые блоки) в prevProject
    }
    try {
      await dbUpdateProject(prevProject);
      console.log('[projects] saved prev project', prevProject.id, 'to DB');
    } catch(e) {
      console.warn('[projects] save prev to DB:', e);
    }
  }

  // Переключаемся
  activeProjectId = id;
  activeProject = projects.find((p) => p.id === id) || project;

  // Заполняем UI проекта.
  projectTitleInput.value = activeProject.name || "Новый проект";
  renderProjectHistory();
  renderProjectsList();

  // Показываем элементы проекта, скрываем empty state.
  projectEmptyState.style.display = "none";
  projectHeader.style.display = "block";
  projectHistoryEl.style.display = "block";

  switchView("new-project");
  npPromptInput.focus();

  // ⚠️ КРИТИЧНО: загружаем блоки НОВОГО проекта в workspace.
  // initBlockly() вызывается в init() ЕДИНОВРЕМЕННО при загрузке dashboard,
  // поэтому blocklyWorkspace здесь уже не null — очистка и загрузка отработают.
  if (typeof loadBlocklyStateForProject === 'function') {
    loadBlocklyStateForProject(activeProject);
  } else {
    console.warn('[projects] loadBlocklyStateForProject not defined!');
  }
}

async function renameActiveProject(newName) {
  if (!activeProject) return;
  const name = (newName || "").trim() || "Без названия";
  if (name === activeProject.name) return;

  activeProject.name = name;
  try {
    await dbUpdateProject(activeProject);
  } catch (err) {
    setNpStatus("Не удалось сохранить имя: " + err.message, "err");
    return;
  }
  renderProjectsList();
}

async function deleteProject(id) {
  const project = projects.find((p) => p.id === id);
  if (!project) return;

  const ok = window.confirm(
    'Удалить проект «' + (project.name || "Без названия") + '»? История и блоки будут потеряны.',
  );
  if (!ok) return;

  try {
    await dbDeleteProject(id);
  } catch (err) {
    setNpStatus("Не удалось удалить: " + err.message, "err");
    return;
  }

  projects = projects.filter((p) => p.id !== id);

  if (activeProjectId === id) {
    activeProjectId = null;
    activeProject = null;
    if (projects.length > 0) {
      await selectProject(projects[0].id);
    } else {
      showProjectEmptyState();
    }
  }
  renderProjectsList();
}

function showProjectEmptyState() {
  projectEmptyState.style.display = "flex";
  projectHeader.style.display = "none";
  projectHistoryEl.style.display = "none";
  switchView("new-project");
}

function renderProjectsList() {
  if (!projects.length) {
    projectsList.innerHTML = '<li class="projects-empty">Нет проектов</li>';
    return;
  }
  projectsList.innerHTML = projects
    .map((p) => {
      const isActive = p.id === activeProjectId;
      const name = escapeHtml(p.name || "Без названия");
      return (
        '<li class="project-item' + (isActive ? " active" : "") + '" data-project-id="' + escapeHtml(p.id) + '">' +
        '<button class="project-name" data-action="select" title="Открыть">' +
        '<span class="proj-ico">💬</span>' +
        '<span class="proj-name-text">' + name + '</span>' +
        "</button>" +
        '<button class="project-delete" data-action="delete" title="Удалить">×</button>' +
        "</li>"
      );
    })
    .join("");
}

function renderProjectHistory() {
  if (!activeProject || !activeProject.history || !activeProject.history.length) {
    projectHistoryEl.innerHTML = '<div class="project-history-empty">Команды появятся здесь после отправки</div>';
    return;
  }
  const items = activeProject.history.slice();
  projectHistoryEl.innerHTML = items
    .map((item) => {
      const isResponse = item.role === "assistant";
      const isAI = item.role === "ai";
      const isUser = !isAI && !isResponse;
      const roleClass = isAI ? " role-ai" : (isResponse ? " role-assistant" : " role-user");

      // Для role-ai (сообщения от блока «вывести в чат»):
      // заголовок берём из item.title — это то, что пользователь ввёл в блоке.
      // Если title нет — заголовок не показываем.
      const aiTitle = (isAI && item.title) ? String(item.title) : "";

      // Шапка остаётся только у user-пузыря (промпт). Для плоских сообщений
      // шапка скрыта через CSS, поэтому не генерируем её — экономим DOM.
      let headerHtml = "";
      if (isUser) {
        let pillText = "→";
        let pillClass = item.status === "ok" ? "" : " err";
        headerHtml =
          '<div class="ph-header">' +
          '<span class="ph-role">вы</span>' +
          '<span class="ph-time">' + formatTime(item.timestamp) + '</span>' +
          '<span class="ph-pill' + pillClass + '">' + pillText + '</span>' +
          '<button class="ph-copy" data-action="copy" title="Копировать текст">⧉</button>' +
          '</div>';
      } else if (isResponse) {
        // Для терминала/open_tab оставим компактную мета-строку (плоской).
        let pillText = "ок";
        if (typeof item.exitCode === "number") pillText = "exit " + item.exitCode;
        else if (item.error === "timeout" || item.error === "native_timeout") pillText = "таймаут";
        else if (item.status !== "ok") pillText = "ошибка";
        headerHtml =
          '<div class="ph-meta">' +
          '<span class="ph-time">' + formatTime(item.timestamp) + '</span>' +
          '<span class="ph-pill' + (item.status === "ok" ? "" : " err") + '">' + pillText + '</span>' +
          '</div>';
      }

      const errorLine = item.status === "ok"
        ? ""
        : '<div class="ph-error">' + escapeHtml(item.error || "") + "</div>";

      // Для role-ai: title — большим шрифтом, тело — отдельно, меньше.
      // Для остальных: тело в ph-body как обычно.
      let bodyHtml;
      if (isAI && aiTitle) {
        bodyHtml =
          '<div class="ph-title">' + escapeHtml(aiTitle) + '</div>' +
          '<div class="ph-body">' + escapeHtml(item.text) + errorLine + '</div>';
      } else {
        bodyHtml = '<div class="ph-body">' + escapeHtml(item.text) + errorLine + '</div>';
      }

      return (
        '<div class="ph-item' + roleClass + '">' +
        headerHtml +
        bodyHtml +
        '</div>'
      );
    })
    .join("");
  requestAnimationFrame(() => {
    projectHistoryEl.scrollTop = projectHistoryEl.scrollHeight;
  });
}

// Event delegation: копирование текста из пузыря чата.
if (projectHistoryEl) {
  projectHistoryEl.addEventListener("click", (e) => {
    const btn = e.target.closest('button[data-action="copy"]');
    if (!btn) return;
    const item = btn.closest(".ph-item");
    if (!item) return;
    const body = item.querySelector(".ph-body");
    if (!body) return;
    const text = body.textContent || "";
    navigator.clipboard.writeText(text).then(() => {
      const orig = btn.textContent;
      btn.textContent = "✓";
      btn.classList.add("copied");
      setTimeout(() => {
        btn.textContent = orig;
        btn.classList.remove("copied");
      }, 1200);
    }).catch(() => {});
  });
}

// Делегирование кликов в списке проектов сайдбара.
projectsList.addEventListener("click", async (e) => {
  const li = e.target.closest(".project-item");
  if (!li) return;
  const id = li.getAttribute("data-project-id");
  const action = e.target.getAttribute("data-action");

  if (action === "delete") {
    e.stopPropagation();
    await deleteProject(id);
    return;
  }
  if (action === "select" || !action) {
    await selectProject(id);
  }
});

projectsList.addEventListener("dblclick", (e) => {
  const nameBtn = e.target.closest('.project-name[data-action="select"]');
  if (!nameBtn) return;
  const li = nameBtn.closest(".project-item");
  if (!li) return;
  const id = li.getAttribute("data-project-id");
  if (id !== activeProjectId) {
    selectProject(id).then(() => {
      projectTitleInput.focus();
      projectTitleInput.select();
    });
  } else {
    projectTitleInput.focus();
    projectTitleInput.select();
  }
});

// ============================================================
// Native Messaging: проверка связи с ОС-терминалом
// ============================================================

async function checkNativeHost() {
  try {
    const resp = await chrome.runtime.sendMessage({ action: 'native_ping' });
    nativeHostStatus = resp || { ok: false, error: 'нет ответа' };
  } catch (e) {
    nativeHostStatus = { ok: false, error: e.message };
  }
  updateNativeHostStatus();
  return nativeHostStatus;
}

function updateNativeHostStatus() {
  if (!connStatusEl) return;
  if (nativeHostStatus.ok) {
    const info = nativeHostStatus.info || {};
    const ver = info.version ? ' v' + info.version : '';
    const plat = info.platform ? ' ' + info.platform : '';
    connStatusEl.textContent = '✓ подключён' + ver + plat;
    connStatusEl.className = 'conn-value ok';
    if (reconnectBtn) reconnectBtn.classList.remove('show');
  } else {
    connStatusEl.textContent = '✗ ' + (nativeHostStatus.error || 'не установлен');
    connStatusEl.className = 'conn-value err';
    if (reconnectBtn) reconnectBtn.classList.add('show');
  }
}

// ============================================================
// Извлечение команды из ответа AI
// AI-ответ содержит пояснения + код в блоках ```bash ... ```
// ============================================================
function extractCommandFromAIResponse(text) {
  if (!text || typeof text !== 'string') return text;

  console.log('[nezar-dash] extractCommand: analyzing AI response (len=' + text.length + ')');

  // Список известных команд — используется для проверки "похожа ли строка на команду"
  const knownCmds = [
    'ls','cd','echo','cat','grep','find','mkdir','rmdir','rm','cp','mv','touch',
    'chmod','chown','git','npm','npx','yarn','pnpm','node','python','python3','pip',
    'pip3','curl','wget','ssh','scp','tar','zip','unzip','head','tail','wc','sort',
    'uniq','awk','sed','ps','kill','df','du','free','top','htop','whoami','pwd',
    'date','cal','which','whereis','man','sudo','apt','apt-get','brew','docker',
    'docker-compose','kubectl','make','cmake','gcc','g++','clang','javac','java',
    'go','cargo','rustc','dotnet','ruby','gem','php','composer','lua','perl',
    'sqlite3','mysql','psql','redis-cli','mongo','mongosh','code','vim','nano',
    'export','source','alias','history','clear','reset','hostname','ifconfig',
    'ip','ping','traceroute','netstat','ss','lsof','systemctl','journalctl',
    'crontab','at','nohup','screen','tmux','xargs','tee','diff','patch','file',
    'stat','basename','dirname','readlink','realpath','tree','du','nc','jq','yq',
    'bat','exa','rg','fd','fzf','tldr','htop','btop','neofetch','fastfetch',
    'true','false','test','sleep','yes','seq','shuf','base64','md5sum','sha256sum',
    'openssl','gpg','hostname','uname','whoami','id','env','printenv','set',
  ];

  // Русские глаголы-действия — если строка начинается с них, это ОПИСАНИЕ шага,
  // а не команда. Тогда нужно искать реальную команду в inline-code.
  const russianActionWords = [
    'Ввести','Проверить','Удалить','Выполнить','Открыть','Запустить','Создать',
    'Изменить','Перейти','Установить','Вставить','Скопировать','Загрузить',
    'Сохранить','Переместить','Заменить','Найти','Добавить','Закрыть','Остановить',
    'Подождать','Обновить','Посмотреть','Записать','Прочитать','Отредактировать',
    'Настроить','Подключить','Отключить','Собрать','Развернуть','Опубликовать',
    'Инициализировать','Зафиксировать','Отправить','Получить','Скомпилировать',
    'Заполнить','Очистить','Выйти','Войти','Перейдите','Введите','Проверьте',
    'Удалите','Выполните','Откройте','Запустите','Создайте','Измените',
  ];

  // Хелпер: очищает строку от markdown-префиксов списка
  const stripListPrefix = (s) => s
    .replace(/^\s*\d+[\.\)]\s*/, '')   // "1. " или "1) "
    .replace(/^\s*[-*•]\s*/, '')        // "- ", "* ", "• "
    .replace(/^\s*\[\s*\]\s*/, '')      // "[ ] " (checkbox)
    .replace(/^\s*\[\s*x\]\s*/i, '')    // "[x] " (checked)
    .trim();

  // Хелпер: проверяет, является ли строка командой (первое слово — knownCmd)
  const isCommandLike = (s) => {
    if (!s) return false;
    const cleaned = stripListPrefix(s);
    if (!cleaned) return false;
    const firstWord = cleaned.split(/[\s|=]/)[0].replace(/^sudo\s+/, '');
    return knownCmds.includes(firstWord);
  };

  // Хелпер: проверяет, является ли строка описанием (начинается с русского глагола)
  const isDescription = (s) => {
    if (!s) return false;
    const cleaned = stripListPrefix(s);
    if (!cleaned) return false;
    for (const word of russianActionWords) {
      if (cleaned.startsWith(word)) return true;
    }
    return false;
  };

  // ─── СТРАТЕГИЯ 1: Code block ```bash ... ``` ─────────────────────────
  const codeBlockMatch = text.match(/```(?:bash|sh|shell|zsh|fish|console|terminal)?\s*\n?([\s\S]*?)```/i);
  if (codeBlockMatch && codeBlockMatch[1]) {
    const cmd = codeBlockMatch[1].trim();
    if (cmd && cmd.length > 0 && cmd.length < 5000) {
      console.log('[nezar-dash] extractCommand: STRATEGY 1 (code block), cmd=' + JSON.stringify(cmd.slice(0, 200)));
      return cmd;
    }
  }

  // ─── СТРАТЕГИЯ 2: Найти ВСЕ inline-code блоки ───────────────────────────
  // AI часто пишет: "1. Ввести `ls -la`" — мы хотим вытащить `ls -la`, а не "Ввести".
  // Если inline-code находятся в нумерованном списке — берём ПЕРВУЮ (первый шаг).
  // Если просто в тексте — берём самую длинную (обычно это финальная/главная команда).
  const inlineMatches = [...text.matchAll(/`([^`\n]{2,500})`/g)];
  if (inlineMatches.length > 0) {
    // Фильтруем: только те, что выглядят как команда
    const candidatesWithCtx = inlineMatches
      .map((m, idx) => {
        const cmd = m[1].trim();
        if (!cmd || cmd.match(/[.!?]$/) || cmd.length < 2) return null;
        const firstWord = cmd.split(/[\s|=]/)[0].replace(/^sudo\s+/, '');
        const isKnownCmd = knownCmds.includes(firstWord);
        const hasShellOps = !!cmd.match(/[\|&;><]/);
        const isPath = !!cmd.match(/^[/~]/);
        const isEnvVar = !!cmd.match(/^\w+=\S/);
        if (!isKnownCmd && !hasShellOps && !isPath && !isEnvVar) return null;
        // Вычисляем позицию в исходном тексте
        const matchIndex = m.index;
        // Берём 80 символов ДО совпадения — чтобы понять контекст (нумерованный список?)
        const before = text.slice(Math.max(0, matchIndex - 80), matchIndex);
        const inNumberedList = !!before.match(/\n\s*\d+[\.\)]\s*\D*$/);
        return { cmd, idx, matchIndex, inNumberedList, length: cmd.length };
      })
      .filter(c => c !== null);

    if (candidatesWithCtx.length > 0) {
      let picked;
      const numberedListCandidates = candidatesWithCtx.filter(c => c.inNumberedList);
      if (numberedListCandidates.length > 0) {
        // В нумерованном списке — берём ПЕРВУЮ команду (первый шаг)
        picked = numberedListCandidates.sort((a, b) => a.matchIndex - b.matchIndex)[0];
        console.log('[nezar-dash] extractCommand: STRATEGY 2 (inline in numbered list, picking FIRST step)');
      } else {
        // Просто в тексте — берём самую длинную (финальную/главную)
        picked = candidatesWithCtx.sort((a, b) => b.length - a.length)[0];
        console.log('[nezar-dash] extractCommand: STRATEGY 2 (inline code, picking LONGEST)');
      }
      console.log('  picked: ' + JSON.stringify(picked.cmd.slice(0, 200)));
      return picked.cmd;
    }
  }

  // ─── СТРАТЕГИЯ 3: Строка начинается с known-команды (без префиксов списка) ─
  const lines = text.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('#') || trimmed.startsWith('//')) continue;
    const cleaned = stripListPrefix(trimmed);
    if (!cleaned) continue;
    const firstWord = cleaned.split(/[\s|=]/)[0].replace(/^sudo\s+/, '');
    if (knownCmds.includes(firstWord)) {
      // Если строка содержит "#" — это комментарий, берём только команду
      const withoutComment = cleaned.split(/\s+#/)[0].trim();
      console.log('[nezar-dash] extractCommand: STRATEGY 3 (line starts with known cmd): ' +
                  JSON.stringify(withoutComment.slice(0, 200)));
      return withoutComment;
    }
  }

  // ─── СТРАТЕГИЯ 4: Multi-line script — первая строка это команда, дальше ещё команды ─
  // Если 2+ строк начинаются с known-команд — это скрипт, берём весь блок
  const cmdLines = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const firstWord = stripListPrefix(trimmed).split(/[\s|=]/)[0].replace(/^sudo\s+/, '');
    if (knownCmds.includes(firstWord)) {
      cmdLines.push(trimmed);
    } else if (cmdLines.length > 0 && (trimmed.startsWith('#') || trimmed === '')) {
      // Продолжаем скрипт через комментарии и пустые строки
      continue;
    } else if (cmdLines.length > 0) {
      // Команды закончились
      break;
    }
  }
  if (cmdLines.length >= 2) {
    const script = cmdLines.join('\n');
    console.log('[nezar-dash] extractCommand: STRATEGY 4 (multi-line script, ' +
                cmdLines.length + ' lines): ' + JSON.stringify(script.slice(0, 200)));
    return script;
  }

  // ─── СТРАТЕГИЯ 5: Поиск shell-конструкций в тексте (pipes, &&, ||) ────────
  // AI мог написать: "you can use ls | grep foo or cat file && head -5"
  const shellPattern = /(?:^|[\s])(sudo\s+)?(?:[a-z][\w-]+)(?:\s+[^\n]*?)?(?:\s*(?:\|\||&&|;|\|)\s*(?:[a-z][\w-]+)(?:\s+[^\n]*?)?)+/g;
  const shellMatches = [...text.matchAll(shellPattern)];
  for (const m of shellMatches) {
    const candidate = m[0].trim();
    if (candidate.length > 5 && candidate.length < 500) {
      console.log('[nezar-dash] extractCommand: STRATEGY 5 (shell construct): ' +
                  JSON.stringify(candidate.slice(0, 200)));
      return candidate;
    }
  }

  // ─── СТРАТЕГИЯ 6: Если ответ начинается с русского глагола — это описание ─
  // Возвращаем пустую строку — safer than garbage.
  const firstNonEmpty = lines.find(l => l.trim());
  if (firstNonEmpty && isDescription(firstNonEmpty)) {
    console.warn('[nezar-dash] extractCommand: STRATEGY 6 — response is a DESCRIPTION (starts with Russian action word), not a command. Returning empty.');
    // Последняя попытка: поиск inline-code без фильтра (может быть команда в нестандартном формате)
    if (inlineMatches.length > 0) {
      // Берём самый длинный inline-code, даже если не похож на команду
      const longest = inlineMatches
        .map(m => m[1].trim())
        .filter(c => c.length > 3 && !c.match(/[.!?]$/))
        .sort((a, b) => b.length - a.length)[0];
      if (longest && longest.length > 5) {
        console.log('[nezar-dash] extractCommand: last-resort inline code: ' + JSON.stringify(longest.slice(0, 200)));
        return longest;
      }
    }
    return '';
  }

  // ─── СТРАТЕГИЯ 7: Fallback — если первая строка НЕ описание и НЕ команда ─
  // Пробуем взять первую строку без признаков предложения
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.match(/[.!?]/)) continue;
    if (trimmed.length > 300) continue;
    // Английские non-command слова
    if (trimmed.match(/^(you|the|this|to|in|for|it|if|when|use|using|can|will|is|are|here|please|sure|first|then|next|after|finally)\s/i)) continue;
    // Маркеры списка
    if (trimmed.match(/^[-*•]\s/)) continue;
    if (trimmed.match(/^\d+[\.\)]\s/)) continue;
    // Русские описательные слова в начале
    if (isDescription(trimmed)) continue;
    // Если первое слово не похоже на команду — пропускаем
    const firstWord = stripListPrefix(trimmed).split(/[\s|=]/)[0];
    if (!knownCmds.includes(firstWord) && !trimmed.match(/[\|&;><]/)) continue;
    console.log('[nezar-dash] extractCommand: STRATEGY 7 (fallback plausible line): ' + JSON.stringify(trimmed.slice(0, 200)));
    return trimmed;
  }

  // ─── ФИНАЛ: ничего не нашли — возвращаем пустую ────────────────────────
  // Лучше пустая команда (нейзар покажет "Не удалось извлечь команду") чем
  // отправлять в терминал мусор типа "Ввести команду ls -la"
  console.warn('[nezar-dash] extractCommand: NO command found in AI response — returning empty');
  return '';
}

// ============================================================
// AI-режим: DeepSeek/Qwen/GLM
// ============================================================

async function checkAITab() {
  console.log('[nezar-dash] checkAITab called');
  try {
    const resp = await chrome.runtime.sendMessage({ action: "find_ai_tab" });
    aiTabStatus = resp || { ok: false, error: "нет ответа" };
  } catch (e) {
    aiTabStatus = { ok: false, error: e.message };
  }
  updateAIStatus();
  return aiTabStatus;
}

function updateAIStatus() {
  if (!aiStatusEl) return;
  if (aiTabStatus.ok) {
    aiStatusEl.textContent = "✓ " + aiTabStatus.site + " найден";
    aiStatusEl.className = "ai-status ok";
  } else {
    aiStatusEl.textContent = "✗ " + (aiTabStatus.error || "не найден");
    aiStatusEl.className = "ai-status err";
  }
}

function toggleAIMode() {
  aiMode = !aiMode;
  if (aiToggleBtn) {
    aiToggleBtn.textContent = "AI режим: " + (aiMode ? "ВКЛ" : "ВЫКЛ");
    aiToggleBtn.className = "ai-toggle" + (aiMode ? " on" : "");
  }
  if (aiMode) {
    checkAITab();
  }
}

// Ждёт ответ от AI (answer_complete или answer_error от background).
function waitForAIResponse(timeoutMs) {
  return new Promise((resolve) => {
    let resolved = false;
    const handler = (msg, sender, sendResponse) => {
      if (resolved) return false;
      if (msg.action === "answer_complete") {
        resolved = true;
        chrome.runtime.onMessage.removeListener(handler);
        if (abortChecker) clearInterval(abortChecker);
        // 🐛 DEBUG: что dashboard получил от content script (через background)
        console.log('%c═══════════ NEZAR DASHBOARD — ANSWER_COMPLETE RECEIVED ═══════════',
          'color: #c084fc; font-weight: bold; font-size: 13px;');
        console.log('%c[text length] ' + (msg.text?.length || 0) + ' chars', 'color: #c084fc;');
        console.log('%c[think length] ' + (msg.think?.length || 0) + ' chars', 'color: #c084fc;');
        console.log('%c─── FULL TEXT ───', 'color: #c084fc;');
        console.log(msg.text || '');
        if (msg.think) {
          console.log('%c─── FULL THINK ───', 'color: #ff9800;');
          console.log(msg.think);
        }
        console.log('%c═══════════════════════════════════════════════════════',
          'color: #c084fc; font-weight: bold; font-size: 13px;');
        sendResponse({ ok: true });
        resolve({ text: msg.text || "", think: msg.think || "" });
      } else if (msg.action === "answer_error") {
        resolved = true;
        chrome.runtime.onMessage.removeListener(handler);
        if (abortChecker) clearInterval(abortChecker);
        sendResponse({ ok: true });
        resolve(null);
      } else if (msg.action === "answer_chunk" && msg.phase === "streaming" && msg.text) {
        setNpStatus("AI отвечает… " + msg.text.length + " символов", "");
      }
      return false;
    };
    chrome.runtime.onMessage.addListener(handler);

    // ⚡ Abort-checker: раз в 200мс проверяем blocklyAbortFlag.
    // Если выставлен — прерываем ожидание AI, резолвим с null.
    // (blocklyAbortFlag — глобальная из blockly.js, доступна здесь)
    let abortChecker = setInterval(() => {
      if (resolved) return;
      if (typeof blocklyAbortFlag !== 'undefined' && blocklyAbortFlag) {
        resolved = true;
        chrome.runtime.onMessage.removeListener(handler);
        clearInterval(abortChecker);
        console.log('[nezar-dash] waitForAIResponse: ABORTED by user');
        resolve(null);
      }
    }, 200);

    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        chrome.runtime.onMessage.removeListener(handler);
        if (abortChecker) clearInterval(abortChecker);
        resolve(null);
      }
    }, timeoutMs);
  });
}

// Показывает индикатор "AI думает..." в чате (три прыгающих точки).
function showProcessingIndicator(site) {
  hideProcessingIndicator();
  const div = document.createElement('div');
  div.className = 'ph-item role-ai processing-indicator';
  div.id = 'processing-indicator';
  div.innerHTML =
    '<div class="ph-header">' +
    '<span class="ph-role">ai</span>' +
    '<span class="ph-time">' + formatTime(Date.now()) + '</span>' +
    '<span class="ph-pill">думает</span>' +
    '</div>' +
    '<div class="ph-body">' +
    '<span class="typing-dots"><span></span><span></span><span></span></span>' +
    '<span class="typing-text"> ' + (site || 'AI') + ' генерирует ответ…</span>' +
    '</div>';
  projectHistoryEl.appendChild(div);
  requestAnimationFrame(() => {
    projectHistoryEl.scrollTop = projectHistoryEl.scrollHeight;
  });
}

function hideProcessingIndicator() {
  const el = document.getElementById('processing-indicator');
  if (el) el.remove();
}

// Хелпер: добавляет запись в историю активного проекта и сохраняет.
async function addHistoryEntry(entry) {
  // Снимаем активную анимацию загрузки (nezar_animate) ДО проверки проекта:
  // если пришло новое сообщение — индикатор «ждёт ответа» больше не нужен,
  // даже если проект по какой-то причине не выбран.
  if (projectHistoryEl) {
    projectHistoryEl.querySelectorAll('.nezar-loading-active').forEach((el) => el.remove());
  }

  if (!activeProject) return;

  if (!Array.isArray(activeProject.history)) activeProject.history = [];
  activeProject.history.push(entry);
  if (activeProject.history.length > 200) {
    activeProject.history = activeProject.history.slice(-200);
  }
  try { await dbUpdateProject(activeProject); } catch (e) { console.error("[projects] addHistoryEntry:", e); }
  renderProjectHistory();
  projects.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  renderProjectsList();
}

// ============================================================
// Отправка: блоки / AI / прямой терминал
// ============================================================

async function handleNewProjectSend() {
  const text = npPromptInput.value.trim();
  if (!text) {
    setNpStatus("Введите команду.", "err");
    npPromptInput.focus();
    return;
  }
  if (!activeProject) {
    setNpStatus("Сначала создайте проект.", "err");
    return;
  }
  if (!nativeHostStatus.ok) {
    setNpStatus("Native host не подключён — терминал недоступен.", "err");
    return;
  }

  // Если есть блоки в Blockly workspace — запускаем интерпретатор.
  if (typeof hasBlocks === 'function' && hasBlocks()) {
    npPromptInput.value = "";
    npPromptInput.focus();
    npSendBtn.disabled = true;
    setNpStatus("Запуск блоков…", "");
    await runBlockly(text);
    npSendBtn.disabled = false;
    setNpStatus("✓ Готово", "ok");
    setTimeout(() => { clearNpStatus(); }, 2000);
    return;
  }

  const requestId = "req_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
  const now = Date.now();

  // 1. Промпт пользователя — всегда в чат
  await addHistoryEntry({
    role: "user",
    text: text,
    timestamp: now,
    status: "ok",
    requestId: requestId,
    aiMode: aiMode,
  });

  npSendBtn.disabled = true;
  npPromptInput.value = "";
  npPromptInput.focus();

  // 2. Ветвление: AI-режим или прямой терминал
  if (aiMode) {
    await handleSendWithAI(text, requestId);
  } else {
    await handleSendDirect(text, requestId, now);
  }

  npSendBtn.disabled = false;
}

// Прямой режим: промпт → Native Messaging терминал.
async function handleSendDirect(text, requestId, now) {
  setNpStatus("Выполнение команды в терминале…", "");

  let resp;
  try {
    resp = await chrome.runtime.sendMessage({
      action: 'native_run',
      command: text,
      cwd: null,
      timeout: 60000,
    });
  } catch (e) {
    setNpStatus("Ошибка: " + e.message, "err");
    await addHistoryEntry({
      role: "assistant",
      text: "(ошибка: " + e.message + ")",
      timestamp: Date.now(),
      status: "err",
      error: e.message,
      requestId: requestId,
    });
    return;
  }

  if (!resp || !resp.ok) {
    const errMsg = (resp && resp.error) || 'неизвестная ошибка';
    const partialOut = resp && (resp.stdout || resp.stderr)
      ? ((resp.stdout || '') + (resp.stderr ? '\n[stderr]\n' + resp.stderr : ''))
      : '';
    setNpStatus("Ошибка: " + errMsg, "err");
    await addHistoryEntry({
      role: "assistant",
      text: partialOut || ("(ошибка: " + errMsg + ")"),
      timestamp: Date.now(),
      status: "err",
      error: errMsg,
      requestId: requestId,
    });
    return;
  }

  const stdout = resp.stdout || '';
  const stderr = resp.stderr || '';
  const exitCode = resp.exitCode;
  const output = (stderr ? stdout + '\n[stderr]\n' + stderr : stdout) || '(нет вывода)';
  const hasError = typeof exitCode === 'number' && exitCode !== 0;

  await addHistoryEntry({
    role: "assistant",
    text: output,
    timestamp: Date.now(),
    status: hasError ? "err" : "ok",
    exitCode: exitCode,
    requestId: requestId,
  });
  setNpStatus("✓ Готово" + (typeof exitCode === "number" ? " (exit " + exitCode + ")" : ""), "ok");
  setTimeout(() => { clearNpStatus(); }, 2500);
}

// AI-режим: промпт → DeepSeek → ответ AI → извлечение команды → Native терминал.
async function handleSendWithAI(text, requestId) {
  console.log('[nezar-dash] handleSendWithAI START');

  const tabInfo = await checkAITab();
  if (!tabInfo.ok) {
    setNpStatus("Нет вкладки AI. Откройте chat.deepseek.com.", "err");
    await addHistoryEntry({
      role: "ai",
      text: "(нет вкладки AI — откройте chat.deepseek.com)",
      timestamp: Date.now(),
      status: "err",
      error: "no_ai_tab",
      requestId: requestId,
    });
    return;
  }

  setNpStatus("Отправка промпта в " + tabInfo.site + "…", "");

  let sendResp;
  try {
    sendResp = await chrome.runtime.sendMessage({ action: "send_to_ai", text: text });
  } catch (e) {
    setNpStatus("Ошибка отправки в AI: " + e.message, "err");
    await addHistoryEntry({
      role: "ai",
      text: "(ошибка отправки: " + e.message + ")",
      timestamp: Date.now(),
      status: "err",
      error: e.message,
      requestId: requestId,
    });
    return;
  }

  if (!sendResp || !sendResp.ok) {
    setNpStatus("AI не принял промпт: " + (sendResp?.error || "неизвестно"), "err");
    await addHistoryEntry({
      role: "ai",
      text: "(ошибка: " + (sendResp?.error || "неизвестно") + ")",
      timestamp: Date.now(),
      status: "err",
      error: sendResp?.error,
      requestId: requestId,
    });
    return;
  }

  showProcessingIndicator(tabInfo.site);
  setNpStatus("AI думает…", "");

  const AI_TIMEOUT = 90000;
  const aiResponse = await waitForAIResponse(AI_TIMEOUT);
  hideProcessingIndicator();

  if (!aiResponse || !aiResponse.text) {
    setNpStatus("Таймаут AI — не ответил за " + (AI_TIMEOUT / 1000) + "с", "err");
    await addHistoryEntry({
      role: "ai",
      text: "(таймаут — AI не ответил за " + (AI_TIMEOUT / 1000) + "с)",
      timestamp: Date.now(),
      status: "err",
      error: "ai_timeout",
      requestId: requestId,
    });
    return;
  }

  // AI ответил — полный текст в чат
  await addHistoryEntry({
    role: "ai",
    text: aiResponse.text,
    timestamp: Date.now(),
    status: "ok",
    requestId: requestId,
    think: aiResponse.think,
  });

  setNpStatus("Извлечение команды из ответа AI…", "");
  const extractedCmd = extractCommandFromAIResponse(aiResponse.text);

  if (!extractedCmd || extractedCmd.length === 0) {
    setNpStatus("Не удалось извлечь команду из ответа AI", "err");
    return;
  }

  setNpStatus("Выполнение команды в терминале…", "");

  let resp;
  try {
    resp = await chrome.runtime.sendMessage({
      action: 'native_run',
      command: extractedCmd,
      cwd: null,
      timeout: 60000,
    });
  } catch (e) {
    setNpStatus("Ошибка терминала: " + e.message, "err");
    await addHistoryEntry({
      role: "assistant",
      text: "(ошибка: " + e.message + ")",
      timestamp: Date.now(),
      status: "err",
      error: e.message,
      requestId: requestId,
    });
    return;
  }

  if (!resp || !resp.ok) {
    const errMsg = (resp && resp.error) || 'неизвестная ошибка';
    const partialOut = resp && (resp.stdout || resp.stderr)
      ? ((resp.stdout || '') + (resp.stderr ? '\n[stderr]\n' + resp.stderr : ''))
      : '';
    setNpStatus("Ошибка: " + errMsg, "err");
    await addHistoryEntry({
      role: "assistant",
      text: partialOut || ("(ошибка: " + errMsg + ")"),
      timestamp: Date.now(),
      status: "err",
      error: errMsg,
      requestId: requestId,
    });
    return;
  }

  const stdout = resp.stdout || '';
  const stderr = resp.stderr || '';
  const exitCode = resp.exitCode;
  const output = (stderr ? stdout + '\n[stderr]\n' + stderr : stdout) || '(нет вывода)';
  const hasError = typeof exitCode === 'number' && exitCode !== 0;

  await addHistoryEntry({
    role: "assistant",
    text: output,
    timestamp: Date.now(),
    status: hasError ? "err" : "ok",
    exitCode: exitCode,
    requestId: requestId,
  });
  setNpStatus("✓ Готово" + (typeof exitCode === "number" ? " (exit " + exitCode + ")" : ""), "ok");
  setTimeout(() => { clearNpStatus(); }, 3000);
}

// ============================================================
// Сворачивание/разворачивание сайдбара
// ============================================================
function setSidebarCollapsed(collapsed) {
  if (collapsed) {
    document.body.classList.add("sidebar-collapsed");
  } else {
    document.body.classList.remove("sidebar-collapsed");
  }
  if (chrome && chrome.storage && chrome.storage.local) {
    chrome.storage.local.set({ sidebarCollapsed: collapsed });
  }
}

function toggleSidebar() {
  const isCollapsed = document.body.classList.contains("sidebar-collapsed");
  setSidebarCollapsed(!isCollapsed);
}

function loadSidebarState() {
  return new Promise((resolve) => {
    if (!chrome || !chrome.storage || !chrome.storage.local) {
      resolve(false);
      return;
    }
    chrome.storage.local.get(["sidebarCollapsed"], (stored) => {
      const collapsed = !!stored.sidebarCollapsed;
      if (collapsed) document.body.classList.add("sidebar-collapsed");
      resolve(collapsed);
    });
  });
}

// ============================================================
// Инициализация
// ============================================================
async function init() {
  await loadSidebarState();
  await loadProjects();

  // ⚠️ КРИТИЧНО: инициализируем Blockly ЕДИНОВРЕМЕННО при загрузке dashboard,
  // чтобы blocklyWorkspace был готов ДО первого selectProject.
  // Панель видна по умолчанию (display:flex в HTML).
  if (typeof initBlockly === 'function') {
    initBlockly();
  } else {
    console.warn('[nezar-dash] initBlockly not defined!');
  }

  // Проверяем связь с native host.
  await checkNativeHost();

  // Логика первичного экрана:
  // - Есть проекты → открываем последний.
  // - Нет проектов → empty state.
  if (projects.length > 0) {
    await selectProject(projects[0].id);
  } else {
    showProjectEmptyState();
  }

  // События
  npSendBtn.addEventListener("click", handleNewProjectSend);
  npPromptInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleNewProjectSend();
    }
  });
  newProjectBtn.addEventListener("click", createNewProject);
  emptyStateCreateBtn.addEventListener("click", createNewProject);
  if (aiToggleBtn) aiToggleBtn.addEventListener("click", toggleAIMode);

  projectTitleInput.addEventListener("change", () => {
    renameActiveProject(projectTitleInput.value);
  });
  projectTitleInput.addEventListener("blur", () => {
    renameActiveProject(projectTitleInput.value);
  });
  projectTitleInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      projectTitleInput.blur();
    } else if (e.key === "Escape") {
      if (activeProject) projectTitleInput.value = activeProject.name || "Новый проект";
      projectTitleInput.blur();
    }
  });

  sidebarCollapseBtn.addEventListener("click", toggleSidebar);
  sidebarExpandBtn.addEventListener("click", toggleSidebar);
  if (reconnectBtn) reconnectBtn.addEventListener("click", checkNativeHost);

  // Ctrl/Cmd+B переключает сайдбар.
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === "b" || e.key === "B")) {
      e.preventDefault();
      toggleSidebar();
    }
  });

  // Периодическая проверка native host (раз в 30 сек)
  setInterval(checkNativeHost, 30000);
}

init();
