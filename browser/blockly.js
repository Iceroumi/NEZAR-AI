/*
 * blockly.js — Blockly workspace для NEZAR (без Firebase).
 *
 * Архитектура состояния (per-project):
 *   editorState — единый объект состояния редактора.
 *   При переключении чата всё editorState сериализуется в activeProject.editorStateSnapshot
 *   и пишется в IndexedDB. При загрузке чата — восстанавливается.
 *
 * Терминал: через Native Messaging (chrome.runtime.sendMessage action:'native_run').
 * Никакого Firebase, никаких API-ключей.
 */

let blocklyWorkspace = null;
let blocklyInitialized = false;

// ============================================================
// Abort-флаг + состояние выполнения
// ============================================================
// blocklyAbortFlag = true → все циклы и long-running await'ы должны
// прерваться при первой возможности. Устанавливается кнопкой Stop.
let blocklyAbortFlag = false;
let blocklyRunning = false;

function setBlocklyRunning(running) {
  blocklyRunning = running;
  if (running) {
    document.body.classList.add('blockly-running');
  } else {
    document.body.classList.remove('blockly-running');
  }
  const stopBtn = document.getElementById('blockly-stop-btn');
  const runBtn = document.getElementById('blockly-run-btn');
  if (stopBtn) stopBtn.disabled = !running;
  if (runBtn) runBtn.disabled = running;
}

function abortBlockly() {
  if (!blocklyRunning) return;
  blocklyAbortFlag = true;
  console.log('[nezar-blockly] ABORT requested — will stop at next block boundary');
}

function isBlocklyAborted() {
  return blocklyAbortFlag;
}

// ============================================================
// Skeleton-анимация на выполняемом блоке
// ============================================================
// Когда блок начинает выполняться — рисуем поверх него:
//   1. CSS-класс .nezar-executing на SVG-группе блока → пульсирующая
//      золотая рамка (см. CSS в dashboard.html)
//   2. SVG <rect> с движущимся градиентом (shimmer-эффект)
// Когда блок закончил — снимаем и то, и другое.

const SVG_NS = 'http://www.w3.org/2000/svg';

// Один раз инжектит <defs> с двумя <linearGradient> в главный Blockly SVG:
//   1) nezar-skeleton-base-gradient — статичный тёмно-серый градиент
//      (для base rect, скрывает содержимое блока как placeholder).
//   2) nezar-skeleton-shimmer-gradient — движущаяся полоса света (wave).
//      5 stop'ов с анимированными offset'ами создают плавную полосу
//      с мягкими краями, бегущую слева→справа каждые 1.4с.
function injectShimmerDefs() {
  if (document.getElementById('nezar-shimmer-defs')) return;
  const svg = document.querySelector('.blocklySvg > svg') ||
              document.querySelector('.blocklySvg svg');
  if (!svg) {
    setTimeout(injectShimmerDefs, 200);
    return;
  }
  const defs = document.createElementNS(SVG_NS, 'defs');
  defs.setAttribute('id', 'nezar-shimmer-defs');

  // --- BASE GRADIENT: тёмно-серый с лёгким вертикальным переходом ---
  const baseGrad = document.createElementNS(SVG_NS, 'linearGradient');
  baseGrad.setAttribute('id', 'nezar-skeleton-base-gradient');
  baseGrad.setAttribute('x1', '0%');
  baseGrad.setAttribute('y1', '0%');
  baseGrad.setAttribute('x2', '0%');
  baseGrad.setAttribute('y2', '100%');
  const baseStops = [
    { offset: '0%',   color: '#3A3F4B', opacity: '0.92' },
    { offset: '50%',  color: '#2D3038', opacity: '0.94' },
    { offset: '100%', color: '#252830', opacity: '0.92' },
  ];
  baseStops.forEach((s) => {
    const stop = document.createElementNS(SVG_NS, 'stop');
    stop.setAttribute('offset', s.offset);
    stop.setAttribute('stop-color', s.color);
    stop.setAttribute('stop-opacity', s.opacity);
    baseGrad.appendChild(stop);
  });
  defs.appendChild(baseGrad);

  // --- SHIMMER GRADIENT: 5 stops, полоса с мягкими краями ---
  // Распределение opacity: 0 → 0.15 → 0.65 → 0.15 → 0
  // Анимируем offset каждого stop'а так, чтобы вся полоса двигалась
  // из позиции [-0.5, 0.0] в [1.0, 1.5] за 1.4с.
  const shimmerGrad = document.createElementNS(SVG_NS, 'linearGradient');
  shimmerGrad.setAttribute('id', 'nezar-skeleton-shimmer-gradient');
  shimmerGrad.setAttribute('x1', '0%');
  shimmerGrad.setAttribute('y1', '0%');
  shimmerGrad.setAttribute('x2', '100%');
  shimmerGrad.setAttribute('y2', '0%');
  // 5 stop'ов, на расстоянии 0.15 друг от друга.
  // Animate each stop's offset: from="-X" to="1+X", где X = i * 0.15
  // Это создает полосу шириной ~60% block, бегущую слева→справа.
  const shimmerStops = [
    { opacity: 0   },  // stop 0: прозрачный левый край
    { opacity: 0.18 }, // stop 1
    { opacity: 0.65 }, // stop 2: пик полосы (ярко-белый)
    { opacity: 0.18 }, // stop 3
    { opacity: 0   },  // stop 4: прозрачный правый край
  ];
  shimmerStops.forEach((s, i) => {
    const startOffset = -0.30 + i * 0.15;  // -0.30, -0.15, 0.0, 0.15, 0.30
    const endOffset   =  1.00 + i * 0.15;  //  1.00,  1.15, 1.3, 1.45, 1.60
    const stop = document.createElementNS(SVG_NS, 'stop');
    stop.setAttribute('offset', String(startOffset));
    stop.setAttribute('stop-color', '#FFFFFF');
    stop.setAttribute('stop-opacity', String(s.opacity));
    const anim = document.createElementNS(SVG_NS, 'animate');
    anim.setAttribute('attributeName', 'offset');
    anim.setAttribute('from', String(startOffset));
    anim.setAttribute('to',   String(endOffset));
    anim.setAttribute('dur', '1.4s');
    anim.setAttribute('repeatCount', 'indefinite');
    stop.appendChild(anim);
    shimmerGrad.appendChild(stop);
  });
  defs.appendChild(shimmerGrad);

  svg.appendChild(defs);
  console.log('[nezar-blockly] skeleton gradients injected');
}

// Включает skeleton-анимацию на блоке. Возвращает handle для отключения.
// Логика:
//   1. CSS-класс .nezar-executing → тонкая золотая обводка (метка active-блока)
//   2. SVG <rect> base-overlay → тёмно-серый placeholder поверх блока
//      (скрывает содержимое, как в React Skeleton)
//   3. SVG <rect> shimmer-overlay → движущаяся полоса света поверх base
//      (wave-effect)
function highlightBlock(block) {
  if (!block) return null;
  let svgRoot = null;
  try { svgRoot = block.getSvgRoot && block.getSvgRoot(); } catch (e) {}
  if (!svgRoot) return null;

  // Гарантируем что градиенты уже инжекчены
  injectShimmerDefs();

  // 1. CSS-класс — тонкая обводка активного блока
  svgRoot.classList.add('nezar-executing');

  // 2 и 3: два rect-оверлея
  let baseRect = null;
  let shimmerRect = null;
  try {
    const path = block.svgPath_;
    if (path) {
      const bbox = path.getBBox();
      const w = Math.max(0, bbox.width);
      const h = Math.max(0, bbox.height);

      // Base rect — тёмно-серый placeholder
      baseRect = document.createElementNS(SVG_NS, 'rect');
      baseRect.setAttribute('x', String(bbox.x));
      baseRect.setAttribute('y', String(bbox.y));
      baseRect.setAttribute('width',  String(w));
      baseRect.setAttribute('height', String(h));
      baseRect.setAttribute('rx', '6');
      baseRect.setAttribute('ry', '6');
      baseRect.setAttribute('fill', 'url(#nezar-skeleton-base-gradient)');
      baseRect.setAttribute('class', 'nezar-skeleton-base');

      // Shimmer rect — бегущая полоса
      shimmerRect = document.createElementNS(SVG_NS, 'rect');
      shimmerRect.setAttribute('x', String(bbox.x));
      shimmerRect.setAttribute('y', String(bbox.y));
      shimmerRect.setAttribute('width',  String(w));
      shimmerRect.setAttribute('height', String(h));
      shimmerRect.setAttribute('rx', '6');
      shimmerRect.setAttribute('ry', '6');
      shimmerRect.setAttribute('fill', 'url(#nezar-skeleton-shimmer-gradient)');
      shimmerRect.setAttribute('class', 'nezar-skeleton-shimmer');

      // Вставляем ПОСЛЕДОВАТЕЛЬНО: сначала base, потом shimmer сверху
      svgRoot.appendChild(baseRect);
      svgRoot.appendChild(shimmerRect);
    }
  } catch (e) {
    console.warn('[nezar-blockly] highlightBlock overlay error:', e);
  }

  // Скроллируем workspace так, чтобы блок был виден
  try {
    if (blocklyWorkspace && typeof blocklyWorkspace.centerOnBlock === 'function') {
      blocklyWorkspace.centerOnBlock(block.id);
    }
  } catch (e) {}

  return { svgRoot, baseRect, shimmerRect };
}

// Выключает skeleton-анимацию. Безопасно вызывать с null.
function unhighlightBlock(handle) {
  if (!handle) return;
  const { svgRoot, baseRect, shimmerRect } = handle;
  try {
    if (shimmerRect && shimmerRect.parentNode) shimmerRect.parentNode.removeChild(shimmerRect);
  } catch (e) {}
  try {
    if (baseRect && baseRect.parentNode) baseRect.parentNode.removeChild(baseRect);
  } catch (e) {}
  try {
    if (svgRoot) svgRoot.classList.remove('nezar-executing');
  } catch (e) {}
}

// ============================================================
// editorState — централизованное состояние Blockly (per-project)
// ============================================================
const editorState = {
  currentProjectId: null,
  blockly: '',
  variables: [],
  runtimeVariables: {},
  skills: {},
  promptText: '',
  vscodeOutput: '',
  clipboard: { blockly: null },
  isLoading: false,
  updatedAt: null,
};

let blocklyVariables = {};
let blocklySkills = {};
let blocklyPromptText = '';
let blocklyVscodeOutput = '';

function syncAliases() {
  blocklyVariables = editorState.runtimeVariables;
  blocklySkills = editorState.skills;
  blocklyPromptText = editorState.promptText;
  blocklyVscodeOutput = editorState.vscodeOutput;
}
syncAliases();

// ============================================================
// Context menu: Copy / Paste block JSON через системный буфер обмена
// ============================================================
// Добавляет пункты в правый клик-меню Blockly:
//   - На блоке:        «📋 Копировать JSON блока»   → BLOCK scope
//   - На workspace:    «📥 Вставить блок из буфера»  → WORKSPACE scope
//
// Использует navigator.clipboard.writeText / readText (OS clipboard),
// с in-memory fallback на editorState.clipboard.blockly если clipboard API
// недоступен (например в небезопасном контексте http://).
//
// В буфер кладётся JSON одного блока (результат Blockly.serialization.blocks.save).
// При вставке поддерживаются:
//   - одиночный блок  { type: "nezar_send_deepseek", ... }
//   - полный state    { blocks: { blocks: [...] }, variables: [...] }
//     (берём первый top-level блок из state.blocks.blocks)

let nezarContextMenuRegistered = false;

function registerNezarContextMenu() {
  if (nezarContextMenuRegistered) return;
  if (typeof Blockly === 'undefined') return;
  if (!Blockly.ContextMenuRegistry || !Blockly.ContextMenuRegistry.registry) return;
  const registry = Blockly.ContextMenuRegistry.registry;
  const ScopeType = Blockly.ContextMenuRegistry.ScopeType;

  // --- 1. COPY: копирует JSON одного блока в OS clipboard ---
  if (!registry.getItem('nezar_copy_block_json')) {
    const copyItem = {
      displayText: '📋 Копировать JSON блока',
      preconditionFn: function (scope) {
        const block = scope && scope.block;
        if (!block) return 'hidden';
        return block.isDeletable() ? 'enabled' : 'hidden';
      },
      callback: function (scope) {
        const block = scope && scope.block;
        if (!block) return;
        try {
          const json = Blockly.serialization.blocks.save(block);
          if (!json) {
            console.warn('[nezar-blockly] copy: serialization returned empty');
            return;
          }
          const text = JSON.stringify(json, null, 2);
          // In-memory store (для fallback при paste)
          editorState.clipboard.blockly = json;
          // OS clipboard
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(() => {
              console.log('[nezar-blockly] block JSON copied to OS clipboard:',
                json.type || '(unknown type)');
            }).catch(err => {
              console.warn('[nezar-blockly] clipboard.writeText failed, in-memory only:', err);
            });
          } else {
            console.warn('[nezar-blockly] clipboard API unavailable, in-memory only');
          }
        } catch (e) {
          console.error('[nezar-blockly] copy block error:', e);
        }
      },
      scopeType: ScopeType.BLOCK,
      id: 'nezar_copy_block_json',
      weight: 5,
    };
    registry.register(copyItem);
  }

  // --- 2. PASTE: вставляет блок из OS clipboard в позицию клика ---
  if (!registry.getItem('nezar_paste_block_json')) {
    const pasteItem = {
      displayText: '📥 Вставить блок из буфера',
      preconditionFn: function (scope) {
        // Всегда enabled — если буфер пуст, покажем alert в callback
        return 'enabled';
      },
      callback: async function (scope) {
        const workspace = (scope && scope.workspace) ||
                          (scope && scope.block && scope.block.workspace) ||
                          blocklyWorkspace;
        if (!workspace) {
          console.warn('[nezar-blockly] paste: no workspace');
          return;
        }

        // Определяем позицию вставки:
        //   1) scope.coords (правый клик на workspace) — лучший вариант
        //   2) центр видимой области workspace
        let targetX = 0, targetY = 0;
        if (scope && scope.coords) {
          targetX = scope.coords.x;
          targetY = scope.coords.y;
        } else {
          try {
            const metrics = workspace.getMetrics();
            targetX = metrics.viewLeft + metrics.viewWidth / 2;
            targetY = metrics.viewTop + metrics.viewHeight / 2;
          } catch (e) {}
        }

        // Читаем JSON: сначала OS clipboard, потом in-memory fallback
        let json = null;
        if (navigator.clipboard && navigator.clipboard.readText) {
          try {
            const text = await navigator.clipboard.readText();
            if (text && text.trim()) {
              json = JSON.parse(text);
              console.log('[nezar-blockly] paste: read from OS clipboard, len=' + text.length);
            }
          } catch (e) {
            console.warn('[nezar-blockly] clipboard.readText failed:', e.message);
          }
        }
        if (!json && editorState.clipboard.blockly) {
          json = editorState.clipboard.blockly;
          console.log('[nezar-blockly] paste: using in-memory clipboard');
        }

        if (!json) {
          alert('Буфер обмена пуст или содержит не-JSON данные.\n' +
                'Сначала right-click на блоке → «📋 Копировать JSON блока».');
          return;
        }

        // Нормализуем: поддерживаем и single-block и full-workspace-state
        let blockJson = json;
        if (json.blocks && json.blocks.blocks) {
          // Full workspace state → берём первый top-level блок
          blockJson = json.blocks.blocks[0];
        }
        if (!blockJson || !blockJson.type) {
          alert('В буфере нет валидного Blockly-блока.\n' +
                'Ожидался JSON вида {"type":"nezar_...", ...}');
          return;
        }

        try {
          // recordUndo: true — добавляет в историю Blockly для Ctrl+Z
          const newBlock = Blockly.serialization.blocks.append(
            blockJson,
            workspace,
            { recordUndo: true }
          );

          if (newBlock) {
            // Двигаем в позицию клика
            try {
              newBlock.render();
              const origin = newBlock.getRelativeToSurfaceXY();
              newBlock.moveBy(targetX - origin.x, targetY - origin.y);
              newBlock.select();
            } catch (e) {
              console.warn('[nezar-blockly] paste: moveBy failed:', e);
            }
            console.log('[nezar-blockly] paste: block "' + (blockJson.type || '?') +
                        '" inserted at (' + targetX.toFixed(0) + ', ' + targetY.toFixed(0) + ')');
          }
        } catch (e) {
          console.error('[nezar-blockly] paste block error:', e);
          alert('Не удалось вставить блок: ' + e.message);
        }
      },
      scopeType: ScopeType.WORKSPACE,
      id: 'nezar_paste_block_json',
      weight: 6,
    };
    registry.register(pasteItem);
  }

  nezarContextMenuRegistered = true;
  console.log('[nezar-blockly] context menu items registered (copy/paste JSON)');
}

// Регистрируем сразу при загрузке скрипта — Blockly уже определён,
// т.к. blockly.min.js подключён раньше blockly.js в dashboard.html.
registerNezarContextMenu();

// ============================================================
// Блоки — все output/inputs только String
// ============================================================
Blockly.defineBlocksWithJsonArray([
  {
    "type": "nezar_prompt",
    "message0": "ПРОМПТ",
    "output": "String",
    "colour": "#63A9AC",
    "tooltip": "Текст из поля ввода чата"
  },
  {
    "type": "nezar_text",
    "message0": "текст %1",
    "args0": [
      { "type": "field_input", "name": "TEXT", "text": "" }
    ],
    "output": "String",
    "colour": "#5b80a5",
    "tooltip": "Текст. Можно заменить на промпт или переменную."
  },
  {
    "type": "nezar_join",
    "message0": "%1 + %2",
    "args0": [
      { "type": "input_value", "name": "A", "check": "String" },
      { "type": "input_value", "name": "B", "check": "String" }
    ],
    "output": "String",
    "colour": "#E37B7D",
    "tooltip": "Объединяет два текста"
  },
  {
    "type": "nezar_get_var",
    "message0": "переменная %1",
    "args0": [
      { "type": "field_input", "name": "NAME", "text": "result" }
    ],
    "output": "String",
    "colour": "#a55b80",
    "tooltip": "Получить значение переменной по имени"
  },
  {
    "type": "nezar_send_deepseek",
    "message0": "запрос к deepseek %1 вкладка %2 ответ в %3",
    "args0": [
      { "type": "input_value", "name": "TEXT", "check": "String" },
      { "type": "input_value", "name": "URL", "check": "String" },
      { "type": "input_value", "name": "VAR", "check": "String" }
    ],
    "previousStatement": null,
    "nextStatement": null,
    "colour": "#5757FF",
    "tooltip": "Запрос в DeepSeek. Ответ в переменную."
  },
  {
    "type": "nezar_send_qwen",
    "message0": "запрос к qwen %1 вкладка %2 ответ в %3",
    "args0": [
      { "type": "input_value", "name": "TEXT", "check": "String" },
      { "type": "input_value", "name": "URL", "check": "String" },
      { "type": "input_value", "name": "VAR", "check": "String" }
    ],
    "previousStatement": null,
    "nextStatement": null,
    "colour": "#7C3AED",
    "tooltip": "Запрос в Qwen. Ответ в переменную."
  },
  {
    "type": "nezar_send_alice",
    "message0": "запрос к алисе %1 вкладка %2 ответ в %3",
    "args0": [
      { "type": "input_value", "name": "TEXT", "check": "String" },
      { "type": "input_value", "name": "URL", "check": "String" },
      { "type": "input_value", "name": "VAR", "check": "String" }
    ],
    "previousStatement": null,
    "nextStatement": null,
    "colour": "#FF3333",
    "tooltip": "Запрос в Яндекс Алису (alice.yandex.ru). Ответ в переменную."
  },
  {
    "type": "nezar_send_native",
    "message0": "терминал native %1 папка %2 вывод в %3",
    "args0": [
      { "type": "input_value", "name": "TEXT", "check": "String" },
      { "type": "input_value", "name": "CWD", "check": "String" },
      { "type": "input_value", "name": "VAR", "check": "String" }
    ],
    "previousStatement": null,
    "nextStatement": null,
    "colour": "#1ABC9C",
    "tooltip": "Выполнить команду в ОС-терминале через Native Messaging. Вывод в переменную."
  },
  {
    "type": "nezar_open_tab",
    "message0": "открыть вкладку %1",
    "args0": [
      { "type": "input_value", "name": "URL", "check": "String" }
    ],
    "previousStatement": null,
    "nextStatement": null,
    "colour": "#FF6B35",
    "tooltip": "Открыть URL в новой вкладке браузера (в фоне). Ждёт завершения загрузки до 30 сек."
  },
  {
    "type": "nezar_skill",
    "message0": "навык %1 %2",
    "args0": [
      { "type": "input_value", "name": "NAME", "check": "String" },
      { "type": "input_statement", "name": "DO" }
    ],
    "previousStatement": null,
    "nextStatement": null,
    "colour": "#9B59B6",
    "tooltip": "Определяет навык (функцию)"
  },
  {
    "type": "nezar_call_skill",
    "message0": "вызов скила %1",
    "args0": [
      { "type": "input_value", "name": "NAME", "check": "String" }
    ],
    "previousStatement": null,
    "nextStatement": null,
    "colour": "#8E44AD",
    "tooltip": "Вызывает навык по имени"
  },
  {
    "type": "nezar_print",
    "message0": "вывести в чат %1",
    "args0": [
      { "type": "input_value", "name": "TEXT", "check": "String" }
    ],
    "previousStatement": null,
    "nextStatement": null,
    "colour": "#34495E",
    "tooltip": "Добавляет текст в чат"
  },
  {
    "type": "nezar_wait",
    "message0": "подождать %1 сек",
    "args0": [
      { "type": "input_value", "name": "TIME", "check": "String" }
    ],
    "previousStatement": null,
    "nextStatement": null,
    "colour": "#FF9800",
    "tooltip": "Приостановить выполнение на N секунд"
  }
]);

// ============================================================
// Функции отправки
// ============================================================

async function nezarSendToDeepSeek(text, url, varName) {
  console.log('[nezar-blockly] DeepSeek:', text.slice(0, 60), '→ var:', varName);
  if (isBlocklyAborted()) {
    blocklyVariables[varName] = '(остановлено)';
    return;
  }
  const tabResp = await chrome.runtime.sendMessage({ action: 'find_tab_by_url', url: url });
  if (isBlocklyAborted()) {
    blocklyVariables[varName] = '(остановлено)';
    return;
  }
  if (!tabResp || !tabResp.ok) {
    blocklyVariables[varName] = '(вкладка не найдена)';
    return;
  }
  const sendResp = await chrome.runtime.sendMessage({
    action: 'send_to_specific_tab',
    tabId: tabResp.tabId,
    text: text,
    site: tabResp.site,
  });
  if (isBlocklyAborted()) {
    blocklyVariables[varName] = '(остановлено)';
    return;
  }
  if (!sendResp || !sendResp.ok) {
    blocklyVariables[varName] = '(ошибка отправки)';
    return;
  }
  const aiResp = await waitForAIResponse(90000);
  if (isBlocklyAborted()) {
    blocklyVariables[varName] = '(остановлено пользователем)';
    return;
  }
  if (aiResp && aiResp.text) {
    blocklyVariables[varName] = aiResp.text;
  } else {
    blocklyVariables[varName] = '(таймаут AI)';
  }
}

// ============================================================
// Открыть вкладку браузера (chrome.tabs.create через background.js)
// ============================================================
// URL может быть любой: https://, http://, file:// (если разрешено).
// Вкладка открывается В ФОНЕ (active: false) — пользователь остаётся в NEZAR.
// Ждёт статус 'complete' до 30 сек, потом продолжает (не блокирует цепочку).
async function nezarOpenTab(url) {
  if (!url) {
    console.warn('[nezar-blockly] open_tab: empty URL');
    return;
  }
  if (isBlocklyAborted()) return;
  console.log('[nezar-blockly] open_tab:', url.slice(0, 80));

  let resp;
  try {
    resp = await chrome.runtime.sendMessage({ action: 'open_tab', url: url });
  } catch (e) {
    console.error('[nezar-blockly] open_tab sendMessage failed:', e.message);
    if (activeProject) {
      await addHistoryEntry({
        role: 'assistant',
        text: '(open_tab ошибка: ' + e.message + ')',
        timestamp: Date.now(),
        status: 'err',
        nodeName: 'open_tab',
      });
    }
    return;
  }

  if (!resp || !resp.ok) {
    const errMsg = (resp && resp.error) || 'неизвестная ошибка';
    console.error('[nezar-blockly] open_tab error:', errMsg);
    if (activeProject) {
      await addHistoryEntry({
        role: 'assistant',
        text: '(open_tab ошибка: ' + errMsg + ')',
        timestamp: Date.now(),
        status: 'err',
        nodeName: 'open_tab',
      });
    }
    return;
  }

  console.log('[nezar-blockly] open_tab OK, tabId=' + resp.tabId +
              (resp.note ? ' (' + resp.note + ')' : ''));
  if (activeProject) {
    await addHistoryEntry({
      role: 'assistant',
      text: '📂 Opened tab: ' + url + (resp.tabId ? ' (tabId=' + resp.tabId + ')' : ''),
      timestamp: Date.now(),
      status: 'ok',
      nodeName: 'open_tab',
    });
  }
}

// ============================================================
// Native Messaging: выполнить команду в ОС-терминале
// (замена Firebase-маршруту через VSCode)
// ============================================================
async function nezarSendToNative(text, cwd, varName) {
  console.log('[nezar-blockly] Native terminal:', text.slice(0, 60), 'cwd:', cwd, '→ var:', varName);
  if (isBlocklyAborted()) {
    if (varName) blocklyVariables[varName] = '(остановлено)';
    return;
  }

  let resp;
  try {
    resp = await chrome.runtime.sendMessage({
      action: 'native_run',
      command: text,
      cwd: cwd || null,
      timeout: 60000,
    });
  } catch (e) {
    console.error('[nezar-blockly] native_run sendMessage failed:', e.message);
    if (varName) blocklyVariables[varName] = '(ошибка: ' + e.message + ')';
    if (activeProject) {
      await addHistoryEntry({
        role: 'assistant',
        text: '(native ошибка: ' + e.message + ')',
        timestamp: Date.now(),
        status: 'err',
        nodeName: 'blockly',
      });
    }
    return;
  }

  if (!resp || !resp.ok) {
    const errMsg = (resp && resp.error) || 'неизвестная ошибка';
    console.error('[nezar-blockly] native_run error:', errMsg);
    if (varName) blocklyVariables[varName] = '(ошибка: ' + errMsg + ')';
    if (activeProject) {
      await addHistoryEntry({
        role: 'assistant',
        text: '(native ошибка: ' + errMsg + ')',
        timestamp: Date.now(),
        status: 'err',
        nodeName: 'blockly',
      });
    }
    return;
  }

  const stdout = resp.stdout || '';
  const stderr = resp.stderr || '';
  const exitCode = resp.exitCode;
  const output = (stderr ? stdout + '\n[stderr]\n' + stderr : stdout) || '(нет вывода)';

  if (varName) {
    blocklyVariables[varName] = output;
    console.log('[nezar-blockly] Native output → "' + varName + '" (exit=' + exitCode + ', len=' + output.length + ')');
  }

  if (activeProject) {
    const hasError = typeof exitCode === 'number' && exitCode !== 0;
    await addHistoryEntry({
      role: 'assistant',
      text: output,
      timestamp: Date.now(),
      status: hasError ? 'err' : 'ok',
      exitCode,
      nodeName: 'blockly',
    });
  }
}

// ============================================================
// Интерпретатор
// ============================================================
function evalBlock(block) {
  if (!block) return '';
  const t = block.type;

  if (t === 'nezar_prompt') return blocklyPromptText;
  if (t === 'nezar_text') return block.getFieldValue('TEXT') || '';
  if (t === 'nezar_join') {
    return String(evalBlock(block.getInputTargetBlock('A'))) + String(evalBlock(block.getInputTargetBlock('B')));
  }

  if (t === 'variables_get') {
    const varField = block.getField('VAR');
    let name = '';
    if (varField && varField.getText) {
      name = varField.getText();
    }
    if (!name) {
      const varId = block.getFieldValue('VAR');
      try {
        if (block.workspace && block.workspace.getVariableById) {
          const variable = block.workspace.getVariableById(varId);
          if (variable) name = variable.name;
        } else if (block.workspace && block.workspace.getVariableMap) {
          const map = block.workspace.getVariableMap();
          const vars = map ? map.getVariablesOfType('') : [];
          const found = vars.find(v => v.getId() === varId);
          if (found) name = found.name;
        }
      } catch(e) {}
    }
    if (!name) name = block.getFieldValue('VAR') || '';
    const val = blocklyVariables[name] !== undefined ? blocklyVariables[name] : '';
    return val;
  }

  if (t === 'text') return block.getFieldValue('TEXT') || '';
  if (t === 'text_join') {
    let r = '';
    for (let i = 0; ; i++) {
      const inp = block.getInput('ADD' + i);
      if (!inp) break;
      r += String(evalBlock(inp.connection && inp.connection.targetBlock()));
    }
    return r;
  }
  if (t === 'text_length') return String(evalBlock(block.getInputTargetBlock('VALUE'))).length;

  if (t === 'math_number') return parseFloat(block.getFieldValue('NUM')) || 0;
  if (t === 'math_arithmetic') {
    const a = evalBlock(block.getInputTargetBlock('A'));
    const b = evalBlock(block.getInputTargetBlock('B'));
    const op = block.getFieldValue('OP');
    if (op === 'ADD') return Number(a) + Number(b);
    if (op === 'MINUS') return Number(a) - Number(b);
    if (op === 'MULTIPLY') return Number(a) * Number(b);
    if (op === 'DIVIDE') return Number(b) !== 0 ? Number(a) / Number(b) : 0;
    return 0;
  }

  if (t === 'logic_boolean') return block.getFieldValue('BOOL') === 'TRUE';
  if (t === 'logic_negate') return !evalBlock(block.getInputTargetBlock('BOOL'));
  if (t === 'logic_compare') {
    const a = evalBlock(block.getInputTargetBlock('A'));
    const b = evalBlock(block.getInputTargetBlock('B'));
    const op = block.getFieldValue('OP');
    if (op === 'EQ') return a == b;
    if (op === 'NEQ') return a != b;
    if (op === 'LT') return Number(a) < Number(b);
    if (op === 'LTE') return Number(a) <= Number(b);
    if (op === 'GT') return Number(a) > Number(b);
    if (op === 'GTE') return Number(a) >= Number(b);
    return false;
  }
  if (t === 'logic_operation') {
    const a = evalBlock(block.getInputTargetBlock('A'));
    const b = evalBlock(block.getInputTargetBlock('B'));
    const op = block.getFieldValue('OP');
    if (op === 'AND') return a && b;
    if (op === 'OR') return a || b;
    return false;
  }

  console.warn('[nezar-blockly] evalBlock unknown:', t);
  return '';
}

async function execBlock(block) {
  if (!block) return;
  if (isBlocklyAborted()) return;
  const t = block.type;
  console.log('[nezar-blockly] execBlock:', t);

  // ⚡ Skeleton-анимация: включаем на время выполнения блока.
  const highlightHandle = highlightBlock(block);

  try {
  const readStr = (inputName) => {
    const b = block.getInputTargetBlock(inputName);
    if (!b) return '';
    return String(evalBlock(b));
  };

  // Универсальный читатель ИМЕНИ переменной из VAR-слота
  const readVarName = () => {
    const varBlock = block.getInputTargetBlock('VAR');
    if (!varBlock) return 'ai_result';
    if (varBlock.type === 'variables_get') {
      const vf = varBlock.getField('VAR');
      return (vf && vf.getText) ? vf.getText() : 'ai_result';
    }
    return String(evalBlock(varBlock)) || 'ai_result';
  };

  if (t === 'nezar_send_deepseek') {
    const text = readStr('TEXT');
    const url = readStr('URL') || 'https://chat.deepseek.com';
    const varName = readVarName();
    await nezarSendToDeepSeek(text, url, varName);
  } else if (t === 'nezar_send_qwen') {
    const text = readStr('TEXT');
    const url = readStr('URL') || 'https://chat.qwen.ai';
    const varName = readVarName();
    await nezarSendToDeepSeek(text, url, varName);
  } else if (t === 'nezar_send_alice') {
    const text = readStr('TEXT');
    const url = readStr('URL') || 'https://alice.yandex.ru/';
    const varName = readVarName();
    // nezarSendToDeepSeek — это универсальный роутер (find_tab_by_url + send_to_specific_tab),
    // работает для любого AI-сайта, не только DeepSeek. Имя историческое.
    await nezarSendToDeepSeek(text, url, varName);
  } else if (t === 'nezar_send_native') {
    const text = readStr('TEXT');
    const cwd = readStr('CWD') || null;
    const varName = readVarName();
    await nezarSendToNative(text, cwd, varName);
  } else if (t === 'nezar_open_tab') {
    const url = readStr('URL');
    await nezarOpenTab(url);
  } else if (t === 'nezar_print') {
    const text = readStr('TEXT');
    if (activeProject) {
      await addHistoryEntry({ role: 'ai', text: text, timestamp: Date.now(), status: 'ok', nodeName: 'blockly' });
    }
  } else if (t === 'nezar_wait') {
    const secondsRaw = readStr('TIME');
    const seconds = parseFloat(secondsRaw.replace(',', '.')) || 0;
    const ms = Math.max(0, Math.min(seconds, 300)) * 1000;
    await new Promise((resolve) => setTimeout(resolve, ms));
  } else if (t === 'variables_set') {
    const varField = block.getField('VAR');
    let name = '';
    if (varField && varField.getText) name = varField.getText();
    if (!name) {
      const varId = block.getFieldValue('VAR');
      try {
        if (block.workspace && block.workspace.getVariableById) {
          const variable = block.workspace.getVariableById(varId);
          if (variable) name = variable.name;
        } else if (block.workspace && block.workspace.getVariableMap) {
          const map = block.workspace.getVariableMap();
          const vars = map ? map.getVariablesOfType('') : [];
          const found = vars.find(v => v.getId() === varId);
          if (found) name = found.name;
        }
      } catch(e) {}
    }
    if (!name) name = block.getFieldValue('VAR') || '';
    const val = evalBlock(block.getInputTargetBlock('VALUE'));
    blocklyVariables[name] = val;
  } else if (t === 'controls_if') {
    let i = 0;
    while (true) {
      const ifInput = block.getInput('IF' + i);
      if (!ifInput) break;
      const condBlock = ifInput.connection && ifInput.connection.targetBlock();
      const cond = evalBlock(condBlock);
      if (cond) {
        const doBlock = block.getInputTargetBlock('DO' + i);
        if (doBlock) await execChain(doBlock);
        return;
      }
      i++;
    }
    const elseBlock = block.getInputTargetBlock('ELSE');
    if (elseBlock) await execChain(elseBlock);
  } else if (t === 'controls_repeat_ext') {
    const times = Math.floor(Number(evalBlock(block.getInputTargetBlock('TIMES')))) || 0;
    const doBlock = block.getInputTargetBlock('DO');
    for (let i = 0; i < times && i < 1000; i++) {
      if (doBlock) await execChain(doBlock);
    }
  } else if (t === 'controls_whileUntil') {
    const mode = block.getFieldValue('MODE');
    const condBlock = block.getInputTargetBlock('BOOL');
    const doBlock = block.getInputTargetBlock('DO');
    let safety = 0;
    if (mode === 'WHILE') {
      while (evalBlock(condBlock) && safety < 1000) { await execChain(doBlock); safety++; }
    } else {
      while (!evalBlock(condBlock) && safety < 1000) { await execChain(doBlock); safety++; }
    }
  } else if (t === 'nezar_skill') {
    const name = readStr('NAME');
    const doBlock = block.getInputTargetBlock('DO');
    blocklySkills[name] = doBlock;
  } else if (t === 'nezar_call_skill') {
    const name = readStr('NAME');
    const doBlock = blocklySkills[name];
    if (doBlock) await execChain(doBlock);
    else console.warn('[nezar-blockly] skill NOT FOUND:', name);
  } else {
    console.warn('[nezar-blockly] execBlock unknown:', t);
  }
  } catch (e) {
    console.error('[nezar-blockly] execBlock error in "' + t + '":', e);
  } finally {
    // ⚡ Всегда снимаем skeleton-анимацию, даже если блок упал с ошибкой
    unhighlightBlock(highlightHandle);
  }
}

async function execChain(block) {
  while (block) {
    if (isBlocklyAborted()) {
      console.log('[nezar-blockly] execChain: abort detected, breaking chain');
      return;
    }
    await execBlock(block);
    block = block.getNextBlock();
  }
}

// ============================================================
// Запуск
// ============================================================
async function runBlockly(promptText) {
  if (!blocklyWorkspace) {
    initBlockly();
    if (!blocklyWorkspace) return false;
  }

  // Если уже запущено — не запускаем повторно (защита от двойного клика)
  if (blocklyRunning) {
    console.log('[nezar-blockly] runBlockly: already running, ignoring');
    return false;
  }

  // Сбрасываем abort-флаг и ставим состояние running
  blocklyAbortFlag = false;
  setBlocklyRunning(true);

  // Инжектим shimmer gradient заранее (если ещё не инжекчен)
  injectShimmerDefs();

  editorState.runtimeVariables = {};
  if (activeProject && activeProject.blocklyVariables) {
    editorState.runtimeVariables = Object.assign({}, activeProject.blocklyVariables);
  }
  editorState.skills = {};
  editorState.promptText = promptText || '';
  editorState.vscodeOutput = '';
  syncAliases();

  const topBlocks = blocklyWorkspace.getTopBlocks(true);
  if (topBlocks.length === 0) {
    setBlocklyRunning(false);
    return false;
  }

  if (promptText && activeProject) {
    await addHistoryEntry({ role: 'user', text: promptText, timestamp: Date.now(), status: 'ok', requestId: 'blockly_' + Date.now() });
  }

  let wasAborted = false;
  try {
    for (const block of topBlocks) {
      if (isBlocklyAborted()) { wasAborted = true; break; }
      await execChain(block);
    }
    if (activeProject && !wasAborted) {
      if (Object.keys(blocklyVariables).length > 0) {
        activeProject.blocklyVariables = Object.assign({}, blocklyVariables);
      }
      if (blocklyWorkspace) {
        try {
          const xml = Blockly.serialization.workspaces.save(blocklyWorkspace);
          activeProject.blocklyWorkspace = JSON.stringify(xml);
        } catch(e) { console.error('[nezar-blockly] save workspace:', e); }
      }
      try { await dbUpdateProject(activeProject); } catch(e) { console.error('[nezar-blockly] save:', e); }
    }
  } catch (err) {
    console.error('[nezar-blockly] runBlockly ERROR:', err.message, err.stack);
  } finally {
    // Всегда снимаем состояние running и пишем финальный статус в чат
    setBlocklyRunning(false);
    blocklyAbortFlag = false;  // готов к следующему запуску
    if (wasAborted && activeProject) {
      try {
        await addHistoryEntry({
          role: 'ai',
          text: '(выполнение остановлено пользователем)',
          timestamp: Date.now(),
          status: 'err',
          error: 'aborted',
          nodeName: 'blockly',
        });
      } catch (e) {}
    }
  }
  return !wasAborted;
}

function hasBlocks() {
  if (!blocklyWorkspace) return false;
  const blocks = blocklyWorkspace.getTopBlocks(false);
  return blocks.length > 0;
}

// ============================================================
// Сохранение/загрузка блоков per-project (через editorState)
// ============================================================

function saveBlocklyState() {
  if (!blocklyWorkspace || !activeProject) return;
  if (editorState.isLoading) return;
  try {
    const state = Blockly.serialization.workspaces.save(blocklyWorkspace);
    editorState.blockly = JSON.stringify(state);
    if (state && state.variables) {
      editorState.variables = state.variables;
    }
    activeProject.blocklyWorkspace = editorState.blockly;
    activeProject.blocklyVariables = Object.assign({}, editorState.runtimeVariables);
    activeProject.blocklySkills = Object.assign({}, editorState.skills);
    activeProject.blocklyPromptText = editorState.promptText;
    activeProject.editorStateSnapshot = JSON.stringify({
      blockly: editorState.blockly,
      variables: editorState.variables,
      runtimeVariables: editorState.runtimeVariables,
      skills: editorState.skills,
      promptText: editorState.promptText,
      vscodeOutput: editorState.vscodeOutput,
      clipboard: editorState.clipboard,
      updatedAt: Date.now(),
    });
    editorState.updatedAt = Date.now();
    editorState.currentProjectId = activeProject.id;
  } catch(e) {
    console.error('[nezar-blockly] saveBlocklyState:', e);
  }
}

// Загружает ПОЛНОЕ состояние editorState из project в workspace.
// 1. Очищает workspace (включая переменные definitions)
// 2. Загружает блоки из project.blocklyWorkspace
// 3. Восстанавливает runtimeVariables, skills, promptText
// 4. Обновляет алиасы
function loadBlocklyStateForProject(project) {
  if (!blocklyWorkspace || !project) {
    console.warn('[nezar-blockly] loadBlocklyStateForProject: SKIP (workspace=' + !!blocklyWorkspace + ', project=' + !!project + ')');
    return;
  }
  console.log('[nezar-blockly] loadBlocklyStateForProject: START for', project.id);

  editorState.isLoading = true;

  try {
    // 1. Очищаем текущие блоки И переменные definitions
    blocklyWorkspace.clear();

    // Дополнительно: очищаем variable map (clear() должен это делать, но на всякий случай)
    try {
      const varMap = blocklyWorkspace.getVariableMap && blocklyWorkspace.getVariableMap();
      if (varMap) {
        const vars = varMap.getVariablesOfType('');
        if (vars && vars.length) {
          for (const v of vars) {
            try { blocklyWorkspace.deleteVariableById(v.getId()); } catch(e) {}
          }
        }
      }
    } catch(e) { console.warn('[nezar-blockly] variable map clear:', e); }

    // 2. Восстанавливаем editorState из проекта
    let restored = false;
    if (project.editorStateSnapshot) {
      try {
        const snap = JSON.parse(project.editorStateSnapshot);
        if (snap) {
          editorState.runtimeVariables = snap.runtimeVariables || {};
          editorState.skills = snap.skills || {};
          editorState.promptText = snap.promptText || '';
          editorState.vscodeOutput = snap.vscodeOutput || '';
          editorState.clipboard = snap.clipboard || { blockly: null };
          editorState.variables = snap.variables || [];
          if (snap.blockly) project.blocklyWorkspace = snap.blockly;
          restored = true;
          console.log('[nezar-blockly] restored from snapshot');
        }
      } catch(e) {
        console.warn('[nezar-blockly] snapshot parse error, fallback to old fields:', e.message);
      }
    }
    if (!restored) {
      editorState.runtimeVariables = project.blocklyVariables ? Object.assign({}, project.blocklyVariables) : {};
      editorState.skills = project.blocklySkills ? Object.assign({}, project.blocklySkills) : {};
      editorState.promptText = project.blocklyPromptText || '';
      editorState.vscodeOutput = '';
      editorState.clipboard = { blockly: null };
      editorState.variables = [];
      console.log('[nezar-blockly] restored from legacy fields');
    }

    editorState.currentProjectId = project.id;
    syncAliases();

    // 3. Загружаем блоки в workspace
    if (project.blocklyWorkspace) {
      try {
        const state = JSON.parse(project.blocklyWorkspace);
        Blockly.serialization.workspaces.load(state, blocklyWorkspace);
        const blockCount = (state && state.blocks && state.blocks.blocks) ? state.blocks.blocks.length : 0;
        console.log('[nezar-blockly] loaded', blockCount, 'blocks for project', project.id);
      } catch(e) {
        console.error('[nezar-blockly] load blocks error:', e);
      }
    } else {
      console.log('[nezar-blockly] empty workspace for', project.id, '(new project)');
    }

    Blockly.svgResize(blocklyWorkspace);
  } finally {
    setTimeout(() => {
      editorState.isLoading = false;
      console.log('[nezar-blockly] loadBlocklyStateForProject: DONE');
    }, 300);
  }
}

// ============================================================
// Копирование / вставка блоков
// ============================================================
function copyAllBlocks() {
  if (!blocklyWorkspace) return;
  try {
    const state = Blockly.serialization.workspaces.save(blocklyWorkspace);
    if (chrome && chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({ blocklyClipboard: JSON.stringify(state) });
    }
    return true;
  } catch(e) {
    console.error('[nezar-blockly] copyAllBlocks:', e);
    return false;
  }
}

function pasteAllBlocks() {
  if (!blocklyWorkspace) return;
  if (!chrome || !chrome.storage || !chrome.storage.local) return;
  chrome.storage.local.get(['blocklyClipboard'], (stored) => {
    if (!stored.blocklyClipboard) return;
    try {
      const state = JSON.parse(stored.blocklyClipboard);
      Blockly.serialization.workspaces.append(state, blocklyWorkspace);
      Blockly.svgResize(blocklyWorkspace);
    } catch(e) {
      console.error('[nezar-blockly] pasteAllBlocks:', e);
    }
  });
}

// ============================================================
// Экспорт / импорт блоков в файл
// ============================================================
function exportBlocksToFile() {
  if (!blocklyWorkspace) return false;
  try {
    const state = Blockly.serialization.workspaces.save(blocklyWorkspace);
    if (!state || !state.blocks || !state.blocks.blocks || state.blocks.blocks.length === 0) {
      alert('Workspace пустой — нечего сохранять');
      return false;
    }
    const payload = {
      format: 'nezar-blockly-v2',
      savedAt: new Date().toISOString(),
      blockCount: state.blocks.blocks.length,
      projectId: activeProject ? activeProject.id : null,
      projectName: activeProject ? activeProject.name : null,
      workspace: state,
      runtimeVariables: editorState.runtimeVariables,
      skills: editorState.skills,
      promptText: editorState.promptText,
    };
    const json = JSON.stringify(payload, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const projectName = (activeProject && activeProject.name) ? activeProject.name.replace(/[^\w\dа-яА-ЯёЁ\-_]+/g, '_').slice(0, 30) : 'workspace';
    const filename = `nezar-${projectName}-${stamp}.nezar.json`;

    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);
    return true;
  } catch(e) {
    console.error('[nezar-blockly] exportBlocksToFile:', e);
    alert('Ошибка экспорта: ' + e.message);
    return false;
  }
}

function importBlocksFromFile(file) {
  if (!blocklyWorkspace || !file) return;
  const reader = new FileReader();
  reader.onload = (evt) => {
    const text = evt.target.result;
    if (!text || typeof text !== 'string') {
      alert('Файл пустой или нечитаемый');
      return;
    }
    try {
      let stateToLoad = null;
      let parsed = null;
      try {
        parsed = JSON.parse(text);
        if (parsed && parsed.workspace) {
          stateToLoad = parsed.workspace;
        } else if (parsed && parsed.blocks) {
          stateToLoad = parsed;
        } else {
          throw new Error('JSON не похож на Blockly workspace');
        }
      } catch (jsonErr) {
        if (text.trim().startsWith('<')) {
          const xml = Blockly.utils.xml.textToDom(text);
          Blockly.Xml.appendDomToWorkspace(xml, blocklyWorkspace);
          Blockly.svgResize(blocklyWorkspace);
          saveBlocklyState();
          return;
        }
        throw jsonErr;
      }
      Blockly.serialization.workspaces.append(stateToLoad, blocklyWorkspace);
      Blockly.svgResize(blocklyWorkspace);
      if (parsed.format === 'nezar-blockly-v2') {
        if (parsed.runtimeVariables) Object.assign(editorState.runtimeVariables, parsed.runtimeVariables);
        if (parsed.skills) Object.assign(editorState.skills, parsed.skills);
        syncAliases();
      }
      saveBlocklyState();
    } catch(e) {
      console.error('[nezar-blockly] importBlocksFromFile:', e);
      alert('Ошибка импорта: ' + e.message);
    }
  };
  reader.readAsText(file);
}

// ============================================================
// Автосохранение блоков при редактировании
// ============================================================
let blocklySaveTimer = null;
let blocklyDBSaveTimer = null;

function scheduleAutosave() {
  if (!blocklyWorkspace || !activeProject) return;
  if (editorState.isLoading) return;
  if (blocklySaveTimer) clearTimeout(blocklySaveTimer);
  blocklySaveTimer = setTimeout(() => {
    try {
      saveBlocklyState();
      const title = document.querySelector('.blockly-panel-title');
      if (title) {
        const oldText = title.textContent;
        if (!oldText.includes('✓')) {
          title.textContent = '✓ ' + oldText;
          setTimeout(() => { title.textContent = oldText; }, 700);
        }
      }
    } catch(e) {
      console.error('[nezar-blockly] autosave error:', e);
    }
  }, 1000);

  if (blocklyDBSaveTimer) clearTimeout(blocklyDBSaveTimer);
  blocklyDBSaveTimer = setTimeout(async () => {
    try {
      if (activeProject && typeof dbUpdateProject === 'function') {
        await dbUpdateProject(activeProject);
      }
    } catch(e) {
      console.error('[nezar-blockly] autosave DB error:', e);
    }
  }, 5000);
}

// ============================================================
// Инициализация
// ============================================================
function initBlockly() {
  if (blocklyInitialized) {
    Blockly.svgResize(blocklyWorkspace);
    return;
  }
  const workspaceDiv = document.getElementById('blockly-workspace');
  const toolbox = document.getElementById('blockly-toolbox');
  if (!workspaceDiv || !toolbox) {
    console.warn('[nezar-blockly] initBlockly: workspace div or toolbox not found');
    return;
  }

  try {
    blocklyWorkspace = Blockly.inject(workspaceDiv, {
      toolbox: toolbox,
      renderer: 'zelos',
      horizontalLayout: true,
      toolboxPosition: 'end',
      move: { scrollbars: { horizontal: true, vertical: true }, drag: true, wheel: true },
      zoom: { controls: true, wheel: true, startScale: 0.85, maxScale: 2, minScale: 0.3 },
      grid: { spacing: 20, length: 1, colour: 'rgba(255,255,255,0.05)', snap: false },
    });
    blocklyInitialized = true;
    window.addEventListener('resize', () => {
      if (blocklyWorkspace) Blockly.svgResize(blocklyWorkspace);
    });
    // Регистрируем пункты правого клик-меню (copy/paste block JSON)
    // Делаем это и здесь (а не только на top-level) на случай если
    // blockly.js загрузился раньше blockly.min.js.
    registerNezarContextMenu();
    console.log('[nezar-blockly] initialized');
  } catch (err) {
    console.error('[nezar-blockly] init error:', err);
  }
}

// Переключение видимости панели блоков.
function toggleBlocklyPanel() {
  const toggleBtn = document.getElementById('blockly-toggle');
  if (document.body.classList.contains('blockly-closed')) {
    document.body.classList.remove('blockly-closed');
    if (toggleBtn) toggleBtn.classList.add('active');
    setTimeout(() => {
      if (blocklyWorkspace) {
        Blockly.svgResize(blocklyWorkspace);
        // Перезагружаем блоки активного проекта (вдруг что-то не досохранилось)
        if (activeProject) loadBlocklyStateForProject(activeProject);
      }
    }, 50);
  } else {
    document.body.classList.add('blockly-closed');
    if (toggleBtn) toggleBtn.classList.remove('active');
    setTimeout(() => {
      if (blocklyWorkspace) Blockly.svgResize(blocklyWorkspace);
    }, 50);
  }
}

// ============================================================
// Ресайзер
// ============================================================
(function() {
  const resizer = document.getElementById('np-resizer');
  if (!resizer) return;

  let isResizing = false;
  resizer.addEventListener('mousedown', (e) => {
    isResizing = true;
    resizer.classList.add('active');
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isResizing) return;
    const view = document.getElementById('view-new-project');
    if (!view) return;
    const rect = view.getBoundingClientRect();
    const newWidth = rect.right - e.clientX;
    const clamped = Math.max(250, Math.min(newWidth, rect.width * 0.85));
    document.documentElement.style.setProperty('--blockly-width', clamped + 'px');
    if (blocklyWorkspace) Blockly.svgResize(blocklyWorkspace);
  });

  document.addEventListener('mouseup', () => {
    if (!isResizing) return;
    isResizing = false;
    resizer.classList.remove('active');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
})();

// ============================================================
// Кнопки панели
// ============================================================
(function() {
  const toggleBtn = document.getElementById('blockly-toggle');
  const closeBtn = document.getElementById('blockly-panel-close');
  const copyBtn = document.getElementById('blockly-copy-btn');
  const pasteBtn = document.getElementById('blockly-paste-btn');
  const exportBtn = document.getElementById('blockly-export-btn');
  const importBtn = document.getElementById('blockly-import-btn');
  const importInput = document.getElementById('blockly-import-input');
  // ⚡ Run / Stop кнопки
  const runBtn = document.getElementById('blockly-run-btn');
  const stopBtn = document.getElementById('blockly-stop-btn');
  if (toggleBtn) toggleBtn.addEventListener('click', toggleBlocklyPanel);
  if (closeBtn) closeBtn.addEventListener('click', toggleBlocklyPanel);
  if (copyBtn) copyBtn.addEventListener('click', () => {
    if (copyAllBlocks()) {
      copyBtn.textContent = '✓';
      setTimeout(() => { copyBtn.textContent = '⧉'; }, 1000);
    }
  });
  if (pasteBtn) pasteBtn.addEventListener('click', () => {
    pasteAllBlocks();
    pasteBtn.textContent = '✓';
    setTimeout(() => { pasteBtn.textContent = '📋'; }, 1000);
  });
  if (exportBtn) exportBtn.addEventListener('click', () => {
    if (exportBlocksToFile()) {
      exportBtn.textContent = '✓';
      setTimeout(() => { exportBtn.textContent = '💾'; }, 1000);
    }
  });
  if (importBtn && importInput) {
    importBtn.addEventListener('click', () => {
      importInput.value = '';
      importInput.click();
    });
    importInput.addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) {
        importBlocksFromFile(file);
        importBtn.textContent = '✓';
        setTimeout(() => { importBtn.textContent = '📂'; }, 1000);
      }
    });
  }

  // ⚡ Run: запускает блоки с текстом из поля ввода промпта
  if (runBtn) {
    runBtn.addEventListener('click', async () => {
      if (blocklyRunning) return;  // защита от двойного клика
      if (!hasBlocks()) {
        // Если блоков нет — ничего не делаем (не запускаем prompt-режим)
        console.log('[nezar-blockly] Run: no blocks in workspace');
        return;
      }
      // Берём текст из поля ввода промпта (если есть)
      const promptInput = document.getElementById('np-prompt');
      const promptText = promptInput ? (promptInput.value || '').trim() : '';
      if (promptInput) promptInput.value = '';
      await runBlockly(promptText);
    });
  }

  // ⚡ Stop: устанавливает abort-флаг
  if (stopBtn) {
    stopBtn.addEventListener('click', () => {
      abortBlockly();
    });
  }

  console.log('[nezar-blockly] events wired');
})();

// ============================================================
// Автосохранение при изменении блоков
// ============================================================
(function wireAutosave() {
  const tryWire = () => {
    if (!blocklyWorkspace) {
      setTimeout(tryWire, 200);
      return;
    }
    if (blocklyWorkspace.addChangeListener) {
      blocklyWorkspace.addChangeListener((event) => {
        if (!event || !event.type) return;
        if (event.isUiEvent) return;
        if (editorState.isLoading) return;
        const saveTypes = [
          Blockly.Events.CREATE,
          Blockly.Events.DELETE,
          Blockly.Events.CHANGE,
          Blockly.Events.MOVE,
          Blockly.Events.VAR_CREATE,
          Blockly.Events.VAR_RENAME,
          Blockly.Events.VAR_DELETE,
        ].filter(t => t);
        if (saveTypes.indexOf(event.type) === -1) return;
        try {
          const state = Blockly.serialization.workspaces.save(blocklyWorkspace);
          if (state && state.variables) {
            editorState.variables = state.variables;
          }
        } catch(e) {}
        scheduleAutosave();
      });
      console.log('[nezar-blockly] autosave listener wired');
    }
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', tryWire);
  } else {
    tryWire();
  }
})();
