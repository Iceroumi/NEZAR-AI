/* ============================================================
 * dashboard.js — логика полностраничного dashboard расширения.
 *
 * Структура:
 *   1. Состояние: cachedSettings (из chrome.storage.sync) +
 *                 history (из chrome.storage.local, последние 20).
 *   2. Навигация: клик по пункту бокового меню переключает вид.
 *   3. Settings: форма → при «Подключить» тестируется реальным
 *      POST+DELETE → при успехе сохраняется и активируется Workspace.
 *   4. Workspace: textarea → POST в Realtime DB → лог в историю.
 * ============================================================ */

// Дефолтные значения (используются, если в chrome.storage ничего нет).
// databaseURL предзаполнен вашим проектом — при первом открытии достаточно нажать «Подключить».
const FIREBASE_DEFAULTS = {
  databaseURL: "https://nezar-acc32-default-rtdb.europe-west1.firebasedatabase.app",
  apiKey: "",
  databasePath: "commands/queue",
  source: "browser-extension",
};

// Состояние.
let cachedSettings = Object.assign({}, FIREBASE_DEFAULTS);
let history = [];          // массив записей {text, timestamp, status, error?}
let isTesting = false;     // флаг идущего теста соединения
const HISTORY_LIMIT = 20;

// Состояние проектов.
let projects = [];           // все проекты из IndexedDB (отсортированы по updatedAt)
let activeProjectId = null;  // ID выбранного проекта
let activeProject = null;    // полный объект выбранного проекта

// AI-режим: промпт отправляется в DeepSeek/Qwen/GLM, ответ — в Firebase как команда.
let aiMode = false;
let aiTabStatus = { ok: false, site: '', error: 'не проверено' };

// Pipeline (Цепочка): массив узлов {id, type, name, url}
let pipelineNodes = [];
let pipelineRunning = false;

// DOM.
const navItems = document.querySelectorAll(".nav-item");
const views = {
  "new-project": document.getElementById("view-new-project"),
  settings: document.getElementById("view-settings"),
  workspace: document.getElementById("view-workspace"),
};

// Settings DOM.
const settingsForm = document.getElementById("settings-form");
const dbUrlInput = document.getElementById("db-url");
const apiKeyInput = document.getElementById("api-key");
const dbPathInput = document.getElementById("db-path");
const sourceInput = document.getElementById("source-name");
const connectBtn = document.getElementById("connect-btn");
const resetBtn = document.getElementById("reset-btn");
const settingsStatus = document.getElementById("settings-status");

// Workspace DOM.
const cmdTextarea = document.getElementById("cmd");
const sendBtn = document.getElementById("send-btn");
const clearBtn = document.getElementById("clear-btn");
const sendStatus = document.getElementById("send-status");
const historyList = document.getElementById("history");

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

// Pipeline DOM (правая панель внутри Новый проект).
const pipelineToggleBtn = document.getElementById("pipeline-toggle");
const pipelinePanel = document.getElementById("pipeline-panel");
const pipelinePanelClose = document.getElementById("pipeline-panel-close");
const pipelineNodesEl = document.getElementById("pipeline-nodes");
const pipelineAddAIBtn = document.getElementById("pipeline-add-ai");
const pipelineAddVSCodeBtn = document.getElementById("pipeline-add-vscode");

// Sidebar footer.
const connStatusEl = document.getElementById("conn-status");

// ============================================================
// Глобальный debug-listener — логирует ВСЕ сообщения в dashboard.
// Помогает найти обрыв в цепочке: content → background → dashboard.
// ============================================================
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  console.log('[nezar-dash] GLOBAL MSG:', msg.action,
    'phase=' + (msg.phase || ''),
    'textLen=' + (msg.text || '').length,
    'bindingId=' + (msg.bindingId || ''),
    'fromTab=' + (sender.tab?.id || 'N/A'));
  // Не перехватываем — другие listeners тоже получат сообщение.
  return false;
});

// ============================================================
// Работа с chrome.storage
// ============================================================

function loadSettings() {
  return new Promise((resolve) => {
    if (!chrome || !chrome.storage || !chrome.storage.sync) {
      resolve(Object.assign({}, FIREBASE_DEFAULTS));
      return;
    }
    chrome.storage.sync.get(
      ["databaseURL", "apiKey", "databasePath", "source"],
      (stored) => {
        cachedSettings = {
          databaseURL: stored.databaseURL || FIREBASE_DEFAULTS.databaseURL,
          apiKey: stored.apiKey || FIREBASE_DEFAULTS.apiKey,
          databasePath: stored.databasePath || FIREBASE_DEFAULTS.databasePath,
          source: stored.source || FIREBASE_DEFAULTS.source,
        };
        resolve(cachedSettings);
      },
    );
  });
}

function saveSettings(values) {
  return new Promise((resolve, reject) => {
    if (!chrome || !chrome.storage || !chrome.storage.sync) {
      cachedSettings = Object.assign({}, values);
      resolve();
      return;
    }
    chrome.storage.sync.set(values, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      cachedSettings = Object.assign({}, values);
      resolve();
    });
  });
}

function loadHistory() {
  return new Promise((resolve) => {
    if (!chrome || !chrome.storage || !chrome.storage.local) {
      resolve([]);
      return;
    }
    chrome.storage.local.get(["history"], (stored) => {
      history = Array.isArray(stored.history) ? stored.history : [];
      resolve(history);
    });
  });
}

function saveHistory(items) {
  return new Promise((resolve, reject) => {
    history = items;
    if (!chrome || !chrome.storage || !chrome.storage.local) {
      resolve();
      return;
    }
    chrome.storage.local.set({ history: items }, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

// ============================================================
// IndexedDB — хранилище проектов (как ChatGPT conversations)
// ============================================================

const DB_NAME = "firebase-bridge-db";
const DB_VERSION = 1;
const STORE_PROJECTS = "projects";

// Открывает (и при необходимости создаёт/мигрирует) БД.
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

// Обновляет проект (name или history). Ставит новый updatedAt.
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
// Firebase REST API
// ============================================================

function buildUrl(dbUrl, dbPath) {
  const base = (dbUrl || "").replace(/\/+$/, "");
  const path = (dbPath || "commands/queue")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  return base + "/" + path + ".json";
}

function isConfigured() {
  const url = cachedSettings.databaseURL || "";
  return url.indexOf("https://") === 0 && url.indexOf("YOUR-PROJECT") === -1;
}

// POST записи в Realtime DB. Возвращает ключ новой записи (name).
async function postRecord(payload) {
  if (!isConfigured()) {
    throw new Error("Firebase не настроен. Откройте «Настройки» и нажмите «Подключить».");
  }
  const url = buildUrl(cachedSettings.databaseURL, cachedSettings.databasePath);
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    let detail = "";
    try {
      const errBody = await resp.json();
      detail = (errBody && errBody.error) || JSON.stringify(errBody);
    } catch (e) {
      detail = await resp.text().catch(() => "");
    }
    throw new Error("HTTP " + resp.status + ": " + detail);
  }
  const result = await resp.json();
  return (result && result.name) || null;
}

// DELETE записи по ключу.
async function deleteRecord(key) {
  const base = cachedSettings.databaseURL.replace(/\/+$/, "");
  const path = (cachedSettings.databasePath || "commands/queue")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  const url = base + "/" + path + "/" + key + ".json";
  const resp = await fetch(url, { method: "DELETE" });
  if (!resp.ok) {
    throw new Error("HTTP " + resp.status + " при удалении тестовой записи");
  }
}

// Тест соединения: POST тестовой записи + DELETE её. Если оба шага прошли — канал работает.
async function testConnection(dbUrl, dbPath) {
  if (dbUrl.indexOf("https://") !== 0) {
    throw new Error("Database URL должен начинаться с https://");
  }
  if (dbUrl.indexOf("YOUR-PROJECT") !== -1) {
    throw new Error("Подставьте реальный Database URL из Firebase Console.");
  }

  // Временно подменяем cachedSettings, чтобы postRecord использовала тестируемый URL.
  const backup = Object.assign({}, cachedSettings);
  cachedSettings.databaseURL = dbUrl;
  cachedSettings.databasePath = dbPath;

  try {
    const testPayload = {
      text: "__connection_test__",
      timestamp: Date.now(),
      source: "connection-test",
      _test: true,
    };
    const name = await postRecord(testPayload);
    if (!name) {
      throw new Error("Firebase вернул пустой ответ на POST.");
    }
    await deleteRecord(name);
    return name;
  } finally {
    // Возвращаем прежние настройки (финальное сохранение произойдёт отдельно, если тест прошёл).
    cachedSettings = backup;
  }
}

// ============================================================
// UI helpers
// ============================================================

function showStatus(el, message, kind) {
  el.textContent = message;
  el.className = "status-line show " + (kind || "");
}

function clearStatus(el) {
  el.textContent = "";
  el.className = "status-line";
}

function updateConnectionStatus() {
  if (isConfigured()) {
    connStatusEl.textContent = "подключён к " + cachedSettings.databaseURL;
    connStatusEl.className = "conn-value ok";
  } else {
    connStatusEl.textContent = "не подключён";
    connStatusEl.className = "conn-value err";
  }
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
  if (name === "new-project") {
    npPromptInput.focus();
    clearNpStatus();
  } else if (name === "workspace") {
    cmdTextarea.focus();
  } else if (name === "settings") {
    dbUrlInput.focus();
  }
}

function formatTime(ts) {
  const d = new Date(ts);
  const pad = (n) => (n < 10 ? "0" + n : "" + n);
  return pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
}

function renderHistory() {
  if (!history.length) {
    historyList.innerHTML = '<li class="history-empty">Пока ничего не отправлено.</li>';
    return;
  }
  historyList.innerHTML = history
    .slice()
    .map((item) => {
      const pillClass = item.status === "ok" ? "" : " err";
      const pillText = item.status === "ok" ? "ок" : "ошибка";
      const errorLine = item.status === "ok" ? "" : '<div style="color:var(--error);font-size:11px;margin-top:4px;">' + escapeHtml(item.error || "") + "</div>";
      return (
        '<li class="history-item">' +
        '<span class="time">' + formatTime(item.timestamp) + '</span>' +
        '<span class="text">' + escapeHtml(item.text) + errorLine + '</span>' +
        '<span class="status-pill' + pillClass + '">' + pillText + '</span>' +
        '</li>'
      );
    })
    .join("");
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ============================================================
// Управление проектами (IndexedDB + sidebar + view)
// ============================================================

// Загрузка всех проектов из IndexedDB в память.
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
  // Дефолтное имя: «Новый проект» или «Новый проект N» если уже есть такие.
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

// Выбор проекта: делает активным, открывает вид, рендерит историю.
async function selectProject(id) {
  const project = projects.find((p) => p.id === id);
  if (!project) return;

  // Если проект не загружен полностью (history может быть пустой в кеше), подтягиваем.
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
}

// Переименование активного проекта (по вводу в project-title-input).
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

// Удаление проекта по ID. После удаления выбираем следующий или показываем empty.
async function deleteProject(id) {
  const project = projects.find((p) => p.id === id);
  if (!project) return;

  // Простой confirm (Chrome extension pages поддерживают window.confirm).
  const ok = window.confirm(
    'Удалить проект «' + (project.name || "Без названия") + '»? История команд будет потеряна.',
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

// Показывает empty state когда нет проектов.
function showProjectEmptyState() {
  projectEmptyState.style.display = "flex";
  projectHeader.style.display = "none";
  projectHistoryEl.style.display = "none";
  switchView("new-project");
}

// Рендерит список проектов в сайдбаре.
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

// Рендерит историю активного проекта в .project-history.
function renderProjectHistory() {
  if (!activeProject || !activeProject.history || !activeProject.history.length) {
    projectHistoryEl.innerHTML = '<div class="project-history-empty">Команды появятся здесь после отправки</div>';
    return;
  }
  // Логика как в диалоге: старые команды вверху, новые внизу.
  const items = activeProject.history.slice();
  projectHistoryEl.innerHTML = items
    .map((item) => {
      const isResponse = item.role === "assistant";
      const isAI = item.role === "ai";
      const roleClass = isAI ? " role-ai" : (isResponse ? " role-assistant" : " role-user");
      const roleLabel = item.nodeName || (isAI ? "ai" : (isResponse ? "terminal" : "вы"));

      let pillText;
      let pillClass = item.status === "ok" ? "" : " err";
      if (isAI) {
        pillText = item.status === "ok" ? "ai" : "ошибка";
      } else if (isResponse) {
        if (typeof item.exitCode === "number") {
          pillText = "exit " + item.exitCode;
        } else if (item.error === "timeout" || item.error === "vscode_timeout") {
          pillText = "таймаут";
        } else {
          pillText = item.status === "ok" ? "ок" : "ошибка";
        }
      } else {
        pillText = "→";
      }

      const errorLine = item.status === "ok"
        ? ""
        : '<div class="ph-error">' + escapeHtml(item.error || "") + "</div>";

      return (
        '<div class="ph-item' + roleClass + '">' +
        '<div class="ph-header">' +
        '<span class="ph-role">' + roleLabel + '</span>' +
        '<span class="ph-time">' + formatTime(item.timestamp) + '</span>' +
        '<span class="ph-pill' + pillClass + '">' + pillText + '</span>' +
        '<button class="ph-copy" data-action="copy" title="Копировать текст">⧉</button>' +
        '</div>' +
        '<div class="ph-body">' +
        escapeHtml(item.text) +
        errorLine +
        '</div>' +
        '</div>'
      );
    })
    .join("");
  // Автопрокрутка вниз — чтобы новая команда/ответ были видны.
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

// Двойной клик по имени проекта в сайдбаре → фокус на инпут названия в виде.
projectsList.addEventListener("dblclick", (e) => {
  const nameBtn = e.target.closest('.project-name[data-action="select"]');
  if (!nameBtn) return;
  const li = nameBtn.closest(".project-item");
  if (!li) return;
  const id = li.getAttribute("data-project-id");
  if (id !== activeProjectId) {
    // Сначала выбираем, потом фокусируемся на инпуте.
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
// Обработчики
// ============================================================

// Переключение видов по клику в сайдбаре (только для пунктов с data-view).
// Кнопка «Новый проект» (без data-view) обрабатывается отдельно.
navItems.forEach((item) => {
  const view = item.getAttribute("data-view");
  if (!view) return;
  item.addEventListener("click", () => {
    switchView(view);
  });
});

// Кнопка «Подключить».
async function handleConnect(e) {
  e.preventDefault();
  if (isTesting) return;

  const dbUrl = dbUrlInput.value.trim();
  const apiKey = apiKeyInput.value.trim();
  const dbPath = dbPathInput.value.trim() || "commands/queue";
  const source = sourceInput.value.trim() || "browser-extension";

  clearStatus(settingsStatus);
  isTesting = true;
  connectBtn.disabled = true;
  connectBtn.textContent = "Проверяю…";

  try {
    const testName = await testConnection(dbUrl, dbPath);
    // Тест прошёл — сохраняем настройки.
    await saveSettings({ databaseURL: dbUrl, apiKey: apiKey, databasePath: dbPath, source: source });
    updateConnectionStatus();
    showStatus(
      settingsStatus,
      "Подключено ✓ Канал работает (тестовая запись " + testName + " записана и удалена).",
      "ok",
    );
    // Автопереход в Workspace через 700 мс.
    setTimeout(() => {
      switchView("workspace");
      clearStatus(settingsStatus);
    }, 700);
  } catch (err) {
    showStatus(settingsStatus, "Ошибка: " + err.message, "err");
  } finally {
    isTesting = false;
    connectBtn.disabled = false;
    connectBtn.textContent = "Подключить";
  }
}

// Кнопка «Сбросить» — очищает форму к дефолтам (но НЕ удаляет сохранённое).
function handleReset() {
  dbUrlInput.value = FIREBASE_DEFAULTS.databaseURL;
  apiKeyInput.value = FIREBASE_DEFAULTS.apiKey;
  dbPathInput.value = FIREBASE_DEFAULTS.databasePath;
  sourceInput.value = FIREBASE_DEFAULTS.source;
  clearStatus(settingsStatus);
  dbUrlInput.focus();
}

// Отправка команды.
async function handleSend() {
  const text = cmdTextarea.value.trim();
  if (!text) {
    showStatus(sendStatus, "Введите текст команды.", "warn");
    return;
  }
  if (!isConfigured()) {
    showStatus(sendStatus, "Firebase не настроен. Откройте «Настройки».", "err");
    return;
  }

  sendBtn.disabled = true;
  showStatus(sendStatus, "Отправка…", "");

  const payload = {
    text: text,
    timestamp: Date.now(),
    source: cachedSettings.source || "browser-extension",
  };

  try {
    const name = await postRecord(payload);
    showStatus(sendStatus, "Отправлено ✓ (запись " + (name || "?") + ")", "ok");
    // Логируем в историю.
    const newHistory = [
      { text: text, timestamp: payload.timestamp, status: "ok" },
    ].concat(history);
    await saveHistory(newHistory.slice(0, HISTORY_LIMIT));
    renderHistory();
  } catch (err) {
    showStatus(sendStatus, "Ошибка: " + err.message, "err");
    const newHistory = [
      { text: text, timestamp: payload.timestamp, status: "err", error: err.message },
    ].concat(history);
    await saveHistory(newHistory.slice(0, HISTORY_LIMIT));
    renderHistory();
  } finally {
    sendBtn.disabled = false;
  }
}

function handleClear() {
  cmdTextarea.value = "";
  cmdTextarea.focus();
  clearStatus(sendStatus);
}

// Горячие клавиши в textarea.
function handleKeydown(e) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    handleSend();
  } else if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
    e.preventDefault();
    handleSend();
  }
}

// ============================================================
// Новый проект — отправка из промпт-бара
// ============================================================

function setNpStatus(message, kind) {
  npStatus.textContent = message;
  npStatus.className = "np-status" + (kind ? " " + kind : "");
}
function clearNpStatus() {
  npStatus.textContent = "";
  npStatus.className = "np-status";
}

// Генерирует уникальный ID запроса для сопоставления команды и ответа.
function generateRequestId() {
  return "req_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
}

// Опрашивает Firebase responses/<requestId>.json до появления ответа или таймаута.
async function waitForResponse(requestId, timeoutMs) {
  const baseUrl = (cachedSettings.databaseURL || "").replace(/\/+$/, "");
  const url = baseUrl + "/responses/" + requestId + ".json";
  const start = Date.now();
  const intervalMs = 500;

  while (Date.now() - start < timeoutMs) {
    try {
      const resp = await fetch(url);
      if (resp.ok) {
        const data = await resp.json();
        if (data !== null && data !== undefined) {
          return data;
        }
      }
    } catch (e) {
      // сетевая ошибка — повтор через интервал.
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}

// ============================================================
// AI-режим: DeepSeek/Qwen/GLM → ответ → Firebase → VSCode
// ============================================================

// Показывает индикатор "AI думает..." в чате (три прыгающих точки).
// Добавляется прямо в DOM, не сохраняется в IndexedDB.
function showProcessingIndicator(site) {
  hideProcessingIndicator(); // убираем предыдущий если был
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
  // Прокручиваем вниз чтобы индикатор был виден.
  requestAnimationFrame(() => {
    projectHistoryEl.scrollTop = projectHistoryEl.scrollHeight;
  });
}

// Убирает индикатор "AI думает...".
function hideProcessingIndicator() {
  const el = document.getElementById('processing-indicator');
  if (el) el.remove();
}

// Хелпер: добавляет запись в историю активного проекта и сохраняет.
async function addHistoryEntry(entry) {
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
// Извлечение команды из ответа AI
// AI-ответ содержит пояснения + код в блоках ```bash ... ```
// Нужно вытащить только команду, иначе терминал получит стихи :)
// ============================================================
function extractCommandFromAIResponse(text) {
  if (!text || typeof text !== 'string') return text;

  console.log('[nezar-dash] extractCommand: analyzing AI response (len=' + text.length + ')');

  // 1. Ищем code block: ```bash ... ``` или ```sh ... ``` или ``` ... ```
  const codeBlockMatch = text.match(/```(?:bash|sh|shell|zsh|fish|console|terminal)?\s*\n?([\s\S]*?)```/i);
  if (codeBlockMatch && codeBlockMatch[1]) {
    const cmd = codeBlockMatch[1].trim();
    console.log('[nezar-dash] extractCommand: found code block, cmd=' + JSON.stringify(cmd.slice(0, 200)));
    return cmd;
  }

  // 2. Ищем inline code: `command`
  const inlineMatch = text.match(/`([^`\n]{2,200})`/);
  if (inlineMatch && inlineMatch[1]) {
    const cmd = inlineMatch[1].trim();
    // Проверяем что это похоже на команду (не предложение)
    if (!cmd.match(/[.!?]/) && !cmd.match(/^(you|the|this|to|in|for|it|if|when|use|using|can|will|is|are)\s/i)) {
      console.log('[nezar-dash] extractCommand: found inline code, cmd=' + JSON.stringify(cmd.slice(0, 200)));
      return cmd;
    }
  }

  // 3. Если НЕТ code block, но ответ начинается с известной команды —
  // возвращаем ВЕСЬ текст (это multi-line скрипт: ls + touch + heredoc + ...).
  // Не вырезаем только первую строку — теряем остальные команды!
  const lines = text.split('\n');
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
  ];
  const firstNonEmpty = lines.find(l => l.trim());
  if (firstNonEmpty) {
    const firstWord = firstNonEmpty.trim().split(/[\s|=]/)[0];
    if (knownCmds.includes(firstWord)) {
      console.log('[nezar-dash] extractCommand: response starts with "' + firstWord + '" — using FULL text (multi-line script)');
      return text.trim();
    }
  }

  // 4. Ищем строки, начинающиеся с известных команд (fallback — если первые строки
  // были пояснением, берём первую строку-команду).
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) continue;
    const firstWord = trimmed.split(/[\s|=]/)[0];
    if (knownCmds.includes(firstWord)) {
      console.log('[nezar-dash] extractCommand: found known command line, cmd=' + JSON.stringify(trimmed.slice(0, 200)));
      return trimmed;
    }
  }

  // 5. Fallback: первая строка без точек/вопросительных (не предложение)
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.match(/[.!?]/)) continue;          // похоже на предложение
    if (trimmed.length > 300) continue;             // слишком длинно
    if (trimmed.match(/^(you|the|this|to|in|for|it|if|when|use|using|can|will|is|are|here|please|sure)\s/i)) continue;
    if (trimmed.match(/^[-*•]\s/)) continue;        // markdown list item
    console.log('[nezar-dash] extractCommand: fallback first plausible line, cmd=' + JSON.stringify(trimmed.slice(0, 200)));
    return trimmed;
  }

  // 5. Last resort: весь текст (лучше чем ничего)
  console.log('[nezar-dash] extractCommand: no extraction found, using full text');
  return text.trim();
}

// Проверяет, есть ли открытая вкладка AI-чата.
async function checkAITab() {
  console.log('[nezar-dash] checkAITab called');
  try {
    const resp = await chrome.runtime.sendMessage({ action: "find_ai_tab" });
    console.log('[nezar-dash] checkAITab response:', resp);
    aiTabStatus = resp || { ok: false, error: "нет ответа" };
  } catch (e) {
    console.error('[nezar-dash] checkAITab error:', e);
    aiTabStatus = { ok: false, error: e.message };
  }
  updateAIStatus();
  return aiTabStatus;
}

// Обновляет индикатор статуса AI-вкладки.
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

// Переключатель AI-режима.
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
// Возвращает { text, think } или null при таймауте/ошибке.
function waitForAIResponse(timeoutMs) {
  console.log('[nezar-dash] waitForAIResponse START, timeout=' + timeoutMs + 'ms');
  return new Promise((resolve) => {
    let resolved = false;

    const handler = (msg, sender, sendResponse) => {
      console.log('[nezar-dash] waitForAIResponse handler got message:', msg.action, 'phase=' + (msg.phase||''), 'textLen=' + (msg.text||'').length, 'resolved=' + resolved);
      if (resolved) {
        console.log('[nezar-dash] already resolved, skipping');
        return false;
      }
      if (msg.action === "answer_complete") {
        resolved = true;
        chrome.runtime.onMessage.removeListener(handler);
        console.log('[nezar-dash] AI COMPLETE! textLen=' + (msg.text||'').length);
        console.log('[nezar-dash] ═══════════════════════════════════════════');
        console.log('[nezar-dash] AI RESPONSE TEXT:');
        console.log(msg.text || '(пустой ответ)');
        console.log('[nezar-dash] ═══════════════════════════════════════════');
        if (msg.think) {
          console.log('[nezar-dash] AI THINK:');
          console.log(msg.think);
        }
        if (msg.note) console.log('[nezar-dash] AI note:', msg.note);
        sendResponse({ ok: true });
        resolve({ text: msg.text || "", think: msg.think || "" });
      } else if (msg.action === "answer_error") {
        resolved = true;
        chrome.runtime.onMessage.removeListener(handler);
        console.log('[nezar-dash] AI ERROR:', msg.error);
        sendResponse({ ok: true });
        resolve(null);
      } else if (msg.action === "answer_chunk" && msg.phase === "streaming" && msg.text) {
        console.log('[nezar-dash] AI streaming chunk: ' + msg.text.length + ' chars');
        setNpStatus("AI отвечает… " + msg.text.length + " символов", "");
      } else if (msg.action === "answer_chunk" && msg.phase === "waiting") {
        console.log('[nezar-dash] AI waiting phase (DeepSeek получил промпт)');
      }
      return false;
    };

    chrome.runtime.onMessage.addListener(handler);
    console.log('[nezar-dash] waitForAIResponse listener ADDED');

    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        chrome.runtime.onMessage.removeListener(handler);
        console.log('[nezar-dash] waitForAIResponse TIMEOUT — no answer in ' + timeoutMs + 'ms');
        resolve(null);
      }
    }, timeoutMs);
  });
}

async function handleNewProjectSend() {
  const text = npPromptInput.value.trim();
  if (!text) {
    setNpStatus("Введите команду.", "err");
    npPromptInput.focus();
    return;
  }
  if (!isConfigured()) {
    setNpStatus("Firebase не настроен — откройте «Настройки».", "err");
    return;
  }
  if (!activeProject) {
    setNpStatus("Сначала создайте проект (кнопка «Новый проект»).", "err");
    return;
  }

  const requestId = generateRequestId();
  const now = Date.now();

  // 1. Промпт пользователя — всегда добавляем в чат (role: "user").
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

  // ---- Если есть узлы цепочки — запускаем pipeline ----
  if (pipelineNodes.length > 0) {
    console.log('[nezar-dash] pipeline has ' + pipelineNodes.length + ' nodes — running pipeline');
    await runPipeline(text);
    return;
  }

  // ---- Ветвление: AI-режим или прямой ----

  if (aiMode) {
    // AI-режим: промпт → DeepSeek → ответ → Firebase → VSCode.
    await handleSendWithAI(text, requestId);
  } else {
    // Прямой режим: промпт → Firebase → VSCode (как раньше).
    await handleSendDirect(text, requestId, now);
  }

  npSendBtn.disabled = false;
}

// Прямой режим (без AI): отправка команды в Firebase, ожидание ответа VSCode.
async function handleSendDirect(text, requestId, now) {
  const payload = {
    text: text,
    timestamp: now,
    source: cachedSettings.source || "browser-extension",
    requestId: requestId,
  };

  setNpStatus("Отправка команды…", "");

  try {
    await postRecord(payload);
    setNpStatus("Команда выполнена. Ожидание вывода из терминала…", "");

    const response = await waitForResponse(requestId, 60000);

    if (response) {
      const exitCode = response.exitCode;
      const hasError = response.error || (typeof exitCode === "number" && exitCode !== 0);
      await addHistoryEntry({
        role: "assistant",
        text: response.output || "(нет вывода)",
        timestamp: response.timestamp || Date.now(),
        status: hasError ? "err" : "ok",
        exitCode: exitCode,
        error: response.error,
        requestId: requestId,
      });
      setNpStatus("✓ Ответ получен" + (typeof exitCode === "number" ? " (exit " + exitCode + ")" : ""), "ok");
    } else {
      await addHistoryEntry({
        role: "assistant",
        text: "(таймаут — VSCode не ответил за 60с)",
        timestamp: Date.now(),
        status: "err",
        error: "timeout",
        requestId: requestId,
      });
      setNpStatus("Таймаут ожидания ответа", "err");
    }

    // Лог в общую историю Workspace.
    const newHistory = [{ text: text, timestamp: now, status: "ok" }].concat(history);
    await saveHistory(newHistory.slice(0, HISTORY_LIMIT));
    renderHistory();

    setTimeout(() => { clearNpStatus(); }, 2500);
  } catch (err) {
    setNpStatus("Ошибка: " + err.message, "err");
    const last = activeProject.history[activeProject.history.length - 1];
    if (last && last.requestId === requestId && last.role === "user") {
      last.status = "err";
      last.error = err.message;
      try { await dbUpdateProject(activeProject); } catch (e) {}
      renderProjectHistory();
    }
  }
}

// AI-режим: промпт → DeepSeek → ответ AI → Firebase (как команда) → VSCode.
async function handleSendWithAI(text, requestId) {
  console.log('[nezar-dash] handleSendWithAI START, textLen=' + text.length + ' requestId=' + requestId);

  // Проверяем AI-вкладку.
  const tabInfo = await checkAITab();
  console.log('[nezar-dash] tabInfo:', tabInfo);
  if (!tabInfo.ok) {
    console.log('[nezar-dash] NO AI tab — aborting');
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
  console.log('[nezar-dash] sending prompt to AI via background...');

  // Отправляем промпт в AI через background → content script.
  let sendResp;
  try {
    sendResp = await chrome.runtime.sendMessage({ action: "send_to_ai", text: text });
    console.log('[nezar-dash] send_to_ai response:', sendResp);
  } catch (e) {
    console.error('[nezar-dash] send_to_ai FAILED:', e);
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
    console.error('[nezar-dash] send_to_ai returned not ok:', sendResp);
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
  console.log('[nezar-dash] prompt sent to AI successfully, response:', sendResp.response);

  // Показываем индикатор "AI думает..." в чате.
  showProcessingIndicator(tabInfo.site);

  // Ждём ответ от AI (стримится через background).
  setNpStatus("AI думает…", "");
  const AI_TIMEOUT = 90000;
  console.log('[nezar-dash] calling waitForAIResponse(' + AI_TIMEOUT + ')...');
  const aiResponse = await waitForAIResponse(AI_TIMEOUT);
  console.log('[nezar-dash] waitForAIResponse returned:', aiResponse ? ('textLen=' + aiResponse.text.length) : 'null');

  // Убираем индикатор — ответ получен (или таймаут/ошибка).
  hideProcessingIndicator();

  if (!aiResponse || !aiResponse.text) {
    console.log('[nezar-dash] AI response null/empty — timeout or error');
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

  console.log('[nezar-dash] AI responded! textLen=' + aiResponse.text.length + ' adding to chat...');

  // AI ответил — добавляем в чат (role: "ai"). Полный текст — для пользователя.
  await addHistoryEntry({
    role: "ai",
    text: aiResponse.text,
    timestamp: Date.now(),
    status: "ok",
    requestId: requestId,
    think: aiResponse.think,
  });
  console.log('[nezar-dash] AI response added to chat, now extracting command...');

  setNpStatus("Извлечение команды из ответа AI…", "");

  // Извлекаем только команду из ответа AI (не отправляем стихи в терминал :)
  const extractedCmd = extractCommandFromAIResponse(aiResponse.text);
  console.log('[nezar-dash] ═══════════════════════════════════════════');
  console.log('[nezar-dash] EXTRACTED COMMAND for VSCode:');
  console.log(extractedCmd);
  console.log('[nezar-dash] ═══════════════════════════════════════════');

  if (!extractedCmd || extractedCmd.length === 0) {
    console.log('[nezar-dash] extraction returned empty — aborting');
    setNpStatus("Не удалось извлечь команду из ответа AI", "err");
    return;
  }

  setNpStatus("Отправка команды в VSCode…", "");

  // Отправляем ИЗВЛЕЧЁННУЮ команду (не весь ответ AI) в Firebase.
  const cmdPayload = {
    text: extractedCmd,
    timestamp: Date.now(),
    source: "ai-" + tabInfo.site,
    requestId: requestId,
  };
  console.log('[nezar-dash] posting extracted command to Firebase...');

  try {
    await postRecord(cmdPayload);
    console.log('[nezar-dash] posted to Firebase, waiting for VSCode response...');
    setNpStatus("Команда отправлена. Ожидание вывода терминала…", "");

    // Ждём ответ от VSCode.
    const vscodeResp = await waitForResponse(requestId, 60000);
    console.log('[nezar-dash] VSCode response:', vscodeResp ? ('outputLen=' + (vscodeResp.output||'').length) : 'null');

    if (vscodeResp) {
      const exitCode = vscodeResp.exitCode;
      const hasError = vscodeResp.error || (typeof exitCode === "number" && exitCode !== 0);
      await addHistoryEntry({
        role: "assistant",
        text: vscodeResp.output || "(нет вывода)",
        timestamp: vscodeResp.timestamp || Date.now(),
        status: hasError ? "err" : "ok",
        exitCode: exitCode,
        error: vscodeResp.error,
        requestId: requestId,
      });
      setNpStatus("✓ Готово" + (typeof exitCode === "number" ? " (exit " + exitCode + ")" : ""), "ok");
    } else {
      await addHistoryEntry({
        role: "assistant",
        text: "(таймаут — VSCode не ответил за 60с)",
        timestamp: Date.now(),
        status: "err",
        error: "vscode_timeout",
        requestId: requestId,
      });
      setNpStatus("Таймаут VSCode", "err");
    }

    setTimeout(() => { clearNpStatus(); }, 3000);
  } catch (err) {
    console.error('[nezar-dash] post to Firebase failed:', err);
    setNpStatus("Ошибка отправки в VSCode: " + err.message, "err");
    await addHistoryEntry({
      role: "assistant",
      text: "(ошибка: " + err.message + ")",
      timestamp: Date.now(),
      status: "err",
      error: err.message,
      requestId: requestId,
    });
  }
}

// ============================================================
// Инициализация
// ============================================================

// ============================================================
// Pipeline (Цепочка): конструктор + выполнение
// Результаты идут в чат проекта (addHistoryEntry), не в отдельный контейнер.
// ============================================================

function savePipeline() {
  if (chrome && chrome.storage && chrome.storage.local) {
    chrome.storage.local.set({ pipelineNodes: pipelineNodes });
  }
}
function loadPipeline() {
  return new Promise((resolve) => {
    if (!chrome || !chrome.storage || !chrome.storage.local) { resolve(); return; }
    chrome.storage.local.get(["pipelineNodes"], (stored) => {
      pipelineNodes = Array.isArray(stored.pipelineNodes) ? stored.pipelineNodes : [];
      renderPipelineNodes();
      resolve();
    });
  });
}

// Toggle правой панели.
function togglePipelinePanel() {
  const isOpen = pipelinePanel.style.display !== "none";
  if (isOpen) {
    pipelinePanel.style.display = "none";
    pipelineToggleBtn.classList.remove("active");
    document.getElementById("view-new-project").classList.remove("pipeline-open");
  } else {
    pipelinePanel.style.display = "flex";
    pipelineToggleBtn.classList.add("active");
    document.getElementById("view-new-project").classList.add("pipeline-open");
  }
}

function addPipelineNode(type) {
  let name = "";
  let url = "";
  if (type === "ai") {
    url = prompt("Вставьте URL вкладки AI чата:", "https://chat.deepseek.com");
    if (!url || !url.trim()) return;
    url = url.trim();
    const defName = url.includes("deepseek") ? "DeepSeek" : url.includes("qwen") ? "Qwen" : url.includes("z.ai") ? "GLM" : "AI";
    name = prompt("Название узла:", defName + " #" + (pipelineNodes.filter(n => n.type === "ai").length + 1));
    if (name === null) return;
    name = (name || "").trim() || defName;
  } else {
    name = "VSCode терминал";
  }
  pipelineNodes.push({
    id: "node_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6),
    type: type, name: name, url: type === "ai" ? url : "",
  });
  savePipeline();
  renderPipelineNodes();
}

function removePipelineNode(id) {
  pipelineNodes = pipelineNodes.filter(n => n.id !== id);
  savePipeline();
  renderPipelineNodes();
}

function movePipelineNode(id, dir) {
  const idx = pipelineNodes.findIndex(n => n.id === id);
  if (idx === -1) return;
  const ni = idx + dir;
  if (ni < 0 || ni >= pipelineNodes.length) return;
  [pipelineNodes[idx], pipelineNodes[ni]] = [pipelineNodes[ni], pipelineNodes[idx]];
  savePipeline();
  renderPipelineNodes();
}

function renderPipelineNodes() {
  if (!pipelineNodesEl) return;
  if (!pipelineNodes.length) {
    pipelineNodesEl.innerHTML = '<div class="pipeline-empty">Нет узлов.</div>';
    return;
  }
  const parts = [];
  for (let i = 0; i < pipelineNodes.length; i++) {
    const node = pipelineNodes[i];
    const icon = node.type === "ai" ? "🟦" : "</>";
    const urlLine = node.type === "ai" && node.url
      ? '<div class="pipeline-node-url">' + escapeHtml(node.url.slice(0, 40)) + '</div>'
      : '<div class="pipeline-node-url">терминал</div>';
    if (i > 0) parts.push('<div class="pipeline-arrow">↓</div>');
    // Используем data-action вместо onclick — CSP MV3 блокирует inline-обработчики.
    parts.push(
      '<div class="pipeline-node" data-node-id="' + escapeHtml(node.id) + '">' +
      '<div class="pipeline-node-num">' + (i + 1) + '</div>' +
      '<div class="pipeline-node-icon">' + icon + '</div>' +
      '<div class="pipeline-node-info">' +
      '<div class="pipeline-node-name">' + escapeHtml(node.name) + '</div>' +
      urlLine +
      '</div>' +
      '<div class="pipeline-node-actions">' +
      '<button data-action="up" data-node-id="' + escapeHtml(node.id) + '" title="Вверх">↑</button>' +
      '<button data-action="down" data-node-id="' + escapeHtml(node.id) + '" title="Вниз">↓</button>' +
      '<button data-action="delete" data-node-id="' + escapeHtml(node.id) + '" class="danger" title="Удалить">×</button>' +
      '</div></div>'
    );
  }
  pipelineNodesEl.innerHTML = parts.join('');
}

// Event delegation для кнопок узлов (вместо onclick — CSP MV3 запрещает inline).
if (pipelineNodesEl) {
  pipelineNodesEl.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const action = btn.getAttribute("data-action");
    const nodeId = btn.getAttribute("data-node-id");
    if (!nodeId) return;
    if (action === "up") movePipelineNode(nodeId, -1);
    else if (action === "down") movePipelineNode(nodeId, 1);
    else if (action === "delete") removePipelineNode(nodeId);
  });
}

// Выполнение цепочки — результаты в чат проекта через addHistoryEntry.
async function runPipeline(promptText) {
  if (pipelineRunning) return false;
  if (!pipelineNodes.length) return false;
  if (!isConfigured()) {
    setNpStatus("Firebase не настроен.", "err");
    return false;
  }

  pipelineRunning = true;
  npSendBtn.disabled = true;

  // Шаг 0: промпт пользователя — уже добавлен в handleNewProjectSend.

  let currentData = promptText;
  let aborted = false;

  for (let i = 0; i < pipelineNodes.length && !aborted; i++) {
    const node = pipelineNodes[i];
    console.log('[nezar-pipeline] step ' + (i+1) + ': ' + node.type + ' "' + node.name + '"');
    setNpStatus("Шаг " + (i+1) + "/" + pipelineNodes.length + ": " + node.name + "…", "");

    // Показываем индикатор для AI узлов.
    if (node.type === "ai") showProcessingIndicator(node.name);

    try {
      if (node.type === "ai") {
        const tabResp = await chrome.runtime.sendMessage({ action: "find_tab_by_url", url: node.url });
        if (!tabResp || !tabResp.ok) {
          hideProcessingIndicator();
          await addHistoryEntry({ role: "ai", text: "(вкладка не найдена: " + node.name + ")", timestamp: Date.now(), status: "err", nodeName: node.name });
          aborted = true; break;
        }
        const sendResp = await chrome.runtime.sendMessage({ action: "send_to_specific_tab", tabId: tabResp.tabId, text: currentData, site: tabResp.site });
        if (!sendResp || !sendResp.ok) {
          hideProcessingIndicator();
          await addHistoryEntry({ role: "ai", text: "(ошибка отправки: " + node.name + ")", timestamp: Date.now(), status: "err", nodeName: node.name });
          aborted = true; break;
        }
        setNpStatus(node.name + " думает…", "");
        const aiResp = await waitForAIResponse(90000);
        hideProcessingIndicator();
        if (!aiResp || !aiResp.text) {
          await addHistoryEntry({ role: "ai", text: "(таймаут AI: " + node.name + ")", timestamp: Date.now(), status: "err", nodeName: node.name });
          aborted = true; break;
        }
        await addHistoryEntry({ role: "ai", text: aiResp.text, timestamp: Date.now(), status: "ok", nodeName: node.name, requestId: "pipeline_" + i });
        const nextNode = pipelineNodes[i + 1];
        currentData = (nextNode && nextNode.type === "vscode")
          ? extractCommandFromAIResponse(aiResp.text)
          : aiResp.text;

      } else if (node.type === "vscode") {
        const reqId = generateRequestId();
        await postRecord({ text: currentData, timestamp: Date.now(), source: "pipeline", requestId: reqId });
        setNpStatus(node.name + " выполняет…", "");
        const vsResp = await waitForResponse(reqId, 60000);
        if (vsResp) {
          const hasErr = vsResp.error || (typeof vsResp.exitCode === "number" && vsResp.exitCode !== 0);
          await addHistoryEntry({ role: "assistant", text: vsResp.output || "(нет вывода)", timestamp: Date.now(), status: hasErr ? "err" : "ok", exitCode: vsResp.exitCode, nodeName: node.name, requestId: reqId });
          currentData = vsResp.output || "";
        } else {
          await addHistoryEntry({ role: "assistant", text: "(таймаут VSCode)", timestamp: Date.now(), status: "err", nodeName: node.name });
          aborted = true; break;
        }
      }
    } catch (err) {
      hideProcessingIndicator();
      await addHistoryEntry({ role: "ai", text: "(ошибка: " + err.message + ")", timestamp: Date.now(), status: "err", nodeName: node.name });
      aborted = true;
    }
  }

  setNpStatus(aborted ? "Цепочка прервана." : "✓ Цепочка завершена", aborted ? "err" : "ok");
  if (!aborted) setTimeout(() => { clearNpStatus(); }, 3000);

  pipelineRunning = false;
  npSendBtn.disabled = false;
  return !aborted;
}

// --- Сворачивание/разворачивание сайдбара ---

function setSidebarCollapsed(collapsed) {
  if (collapsed) {
    document.body.classList.add("sidebar-collapsed");
  } else {
    document.body.classList.remove("sidebar-collapsed");
  }
  // Сохраняем состояние, чтобы при следующем открытии оно сохранялось.
  if (chrome && chrome.storage && chrome.storage.local) {
    chrome.storage.local.set({ sidebarCollapsed: collapsed });
  }
}

function toggleSidebar() {
  const isCollapsed = document.body.classList.contains("sidebar-collapsed");
  setSidebarCollapsed(!isCollapsed);
}

// Загрузка сохранённого состояния сайдбара.
function loadSidebarState() {
  return new Promise((resolve) => {
    if (!chrome || !chrome.storage || !chrome.storage.local) {
      resolve(false);
      return;
    }
    chrome.storage.local.get(["sidebarCollapsed"], (stored) => {
      const collapsed = !!stored.sidebarCollapsed;
      if (collapsed) {
        document.body.classList.add("sidebar-collapsed");
      }
      resolve(collapsed);
    });
  });
}

async function init() {
  await loadSettings();
  await loadHistory();
  await loadSidebarState();
  await loadPipeline();
  await loadProjects();

  // Заполняем форму текущими сохранёнными значениями.
  dbUrlInput.value = cachedSettings.databaseURL || "";
  apiKeyInput.value = cachedSettings.apiKey || "";
  dbPathInput.value = cachedSettings.databasePath || "commands/queue";
  sourceInput.value = cachedSettings.source || "browser-extension";

  updateConnectionStatus();
  renderHistory();

  // Логика первичного экрана:
  // - Не настроено → Настройки.
  // - Настроено + есть проекты → открываем последний проект.
  // - Настроено + нет проектов → empty state в проект-виде.
  if (!isConfigured()) {
    switchView("settings");
  } else if (projects.length > 0) {
    await selectProject(projects[0].id);
  } else {
    showProjectEmptyState();
  }

  // События.
  settingsForm.addEventListener("submit", handleConnect);
  resetBtn.addEventListener("click", handleReset);
  sendBtn.addEventListener("click", handleSend);
  clearBtn.addEventListener("click", handleClear);
  cmdTextarea.addEventListener("keydown", handleKeydown);
  // Новый проект: кнопка и Enter в инпуте.
  npSendBtn.addEventListener("click", handleNewProjectSend);
  npPromptInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleNewProjectSend();
    }
  });
  // Создание нового проекта.
  newProjectBtn.addEventListener("click", createNewProject);
  emptyStateCreateBtn.addEventListener("click", createNewProject);
  // AI-режим: переключатель.
  if (aiToggleBtn) {
    aiToggleBtn.addEventListener("click", toggleAIMode);
  }
  // Pipeline: кнопки панели.
  if (pipelineToggleBtn) pipelineToggleBtn.addEventListener("click", togglePipelinePanel);
  if (pipelinePanelClose) pipelinePanelClose.addEventListener("click", togglePipelinePanel);
  if (pipelineAddAIBtn) pipelineAddAIBtn.addEventListener("click", () => addPipelineNode("ai"));
  if (pipelineAddVSCodeBtn) pipelineAddVSCodeBtn.addEventListener("click", () => addPipelineNode("vscode"));
  // Переименование активного проекта по изменению инпута заголовка.
  projectTitleInput.addEventListener("change", () => {
    renameActiveProject(projectTitleInput.value);
  });
  projectTitleInput.addEventListener("blur", () => {
    renameActiveProject(projectTitleInput.value);
  });
  // Enter в инпуте названия → сохранить + убрать фокус.
  projectTitleInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      projectTitleInput.blur();
    } else if (e.key === "Escape") {
      // Отмена — возвращаем сохранённое имя.
      if (activeProject) projectTitleInput.value = activeProject.name || "Новый проект";
      projectTitleInput.blur();
    }
  });
  // Сайдбар: сворачивание/разворачивание.
  sidebarCollapseBtn.addEventListener("click", toggleSidebar);
  sidebarExpandBtn.addEventListener("click", toggleSidebar);
  // Горячая клавиша: Ctrl/Cmd+B переключает сайдбар.
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === "b" || e.key === "B")) {
      e.preventDefault();
      toggleSidebar();
    }
  });
}

init();
