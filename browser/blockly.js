/*
 * blockly.js — Blockly workspace для NEZAR.
 *
 * Прямой интерпретатор блоков — без eval/new Function (MV3 CSP запрещает).
 * Обходим дерево блоков Blockly и выполняем каждый тип напрямую.
 *
 * Кастомные блоки:
 *   - nezar_send_prompt: отправляет текст в Firebase → VSCode терминал
 *   - nezar_prompt_text: текстовое поле для промпта
 */

let blocklyWorkspace = null;
let blocklyInitialized = false;
let blocklyVariables = {}; // хранилище переменных для блоков

// ============================================================
// Кастомные блоки (только определения, без генератора кода)
// ============================================================

Blockly.defineBlocksWithJsonArray([
  {
    "type": "nezar_send_prompt",
    "message0": "отправить промпт %1",
    "args0": [
      { "type": "input_value", "name": "TEXT", "check": "String" }
    ],
    "previousStatement": null,
    "nextStatement": null,
    "colour": "#7034e8",
    "tooltip": "Отправляет текст в Firebase → VSCode терминал"
  },
  {
    "type": "nezar_prompt_text",
    "message0": "промпт: %1",
    "args0": [
      { "type": "field_input", "name": "TEXT", "text": "echo Привет из блоков" }
    ],
    "output": "String",
    "colour": "#7034e8",
    "tooltip": "Текст промпта"
  }
]);

// ============================================================
// nezarSendPrompt — полная отправка промпта
// ============================================================

async function nezarSendPrompt(text) {
  console.log('[nezar-blockly] sendPrompt:', text);
  if (!activeProject || !isConfigured()) {
    console.log('[nezar-blockly] нет проекта или Firebase не настроен');
    return;
  }
  const requestId = generateRequestId();
  const now = Date.now();
  await addHistoryEntry({ role: "user", text: text, timestamp: now, status: "ok", requestId });
  await postRecord({ text: text, timestamp: now, source: "blockly", requestId });
  const response = await waitForResponse(requestId, 60000);
  if (response) {
    const exitCode = response.exitCode;
    const hasError = response.error || (typeof exitCode === "number" && exitCode !== 0);
    await addHistoryEntry({ role: "assistant", text: response.output || "(нет вывода)", timestamp: response.timestamp || Date.now(), status: hasError ? "err" : "ok", exitCode, error: response.error, requestId });
  } else {
    await addHistoryEntry({ role: "assistant", text: "(таймаут)", timestamp: Date.now(), status: "err", error: "timeout", requestId });
  }
}

// ============================================================
// Прямой интерпретатор блоков — без eval (CSP-совместимо)
// ============================================================

// Вычисляет value-блок (возвращает значение)
function evalBlock(block) {
  if (!block) return '';
  const t = block.type;

  if (t === 'text' || t === 'nezar_prompt_text') return block.getFieldValue('TEXT') || '';
  if (t === 'math_number') return parseFloat(block.getFieldValue('NUM')) || 0;
  if (t === 'logic_boolean') return block.getFieldValue('BOOL') === 'TRUE';
  if (t === 'logic_null') return null;

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
  if (t === 'math_arithmetic') {
    const a = evalBlock(block.getInputTargetBlock('A'));
    const b = evalBlock(block.getInputTargetBlock('B'));
    const op = block.getFieldValue('OP');
    if (op === 'ADD') return a + b;
    if (op === 'MINUS') return a - b;
    if (op === 'MULTIPLY') return a * b;
    if (op === 'DIVIDE') return b !== 0 ? a / b : 0;
    if (op === 'POWER') return Math.pow(a, b);
    return 0;
  }
  if (t === 'math_random_int') {
    const from = evalBlock(block.getInputTargetBlock('FROM'));
    const to = evalBlock(block.getInputTargetBlock('TO'));
    return Math.floor(Math.random() * (to - from + 1)) + from;
  }
  if (t === 'math_modulo') {
    const a = evalBlock(block.getInputTargetBlock('DIVIDEND'));
    const b = evalBlock(block.getInputTargetBlock('DIVISOR'));
    return b !== 0 ? a % b : 0;
  }
  if (t === 'logic_compare') {
    const a = evalBlock(block.getInputTargetBlock('A'));
    const b = evalBlock(block.getInputTargetBlock('B'));
    const op = block.getFieldValue('OP');
    if (op === 'EQ') return a == b;
    if (op === 'NEQ') return a != b;
    if (op === 'LT') return a < b;
    if (op === 'LTE') return a <= b;
    if (op === 'GT') return a > b;
    if (op === 'GTE') return a >= b;
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
  if (t === 'logic_negate') return !evalBlock(block.getInputTargetBlock('BOOL'));
  if (t === 'variables_get') {
    const v = block.workspace.getVariableById(block.getFieldValue('VAR'));
    return v ? (blocklyVariables[v.name] !== undefined ? blocklyVariables[v.name] : '') : '';
  }
  if (t === 'variables_set') {
    const v = block.workspace.getVariableById(block.getFieldValue('VAR'));
    const val = evalBlock(block.getInputTargetBlock('VALUE'));
    if (v) blocklyVariables[v.name] = val;
    return val;
  }
  if (t === 'text_print') {
    const val = evalBlock(block.getInputTargetBlock('TEXT'));
    console.log('[nezar-blockly] print:', val);
    return '';
  }

  console.warn('[nezar-blockly] unknown value block:', t);
  return '';
}

// Выполняет statement-блок (возвращает async)
async function execBlock(block) {
  if (!block) return;
  const t = block.type;

  if (t === 'nezar_send_prompt') {
    const text = evalBlock(block.getInputTargetBlock('TEXT'));
    await nezarSendPrompt(String(text));
  } else if (t === 'variables_set') {
    evalBlock(block); // variables_set обрабатывается в evalBlock
  } else if (t === 'text_print') {
    evalBlock(block);
  } else if (t === 'controls_if') {
    // Обрабатываем все ветки if/elseif/else
    let i = 0;
    while (true) {
      const ifInput = block.getInput('IF' + i);
      if (!ifInput) break;
      const condition = evalBlock(ifInput.connection && ifInput.connection.targetBlock());
      if (condition) {
        const doBlock = block.getInputTargetBlock('DO' + i);
        await execChain(doBlock);
        return;
      }
      i++;
    }
    // else
    const elseBlock = block.getInputTargetBlock('ELSE');
    if (elseBlock) await execChain(elseBlock);
  } else if (t === 'controls_repeat_ext') {
    const times = evalBlock(block.getInputTargetBlock('TIMES'));
    const doBlock = block.getInputTargetBlock('DO');
    for (let i = 0; i < times; i++) {
      await execChain(doBlock);
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
  } else {
    console.warn('[nezar-blockly] unknown statement block:', t);
  }
}

// Выполняет цепочку statement-блоков (connected via next)
async function execChain(block) {
  while (block) {
    await execBlock(block);
    block = block.getNextBlock();
  }
}

// ============================================================
// Выполнение всех блоков в workspace
// ============================================================

async function runBlockly() {
  if (!blocklyWorkspace) {
    console.log('[nezar-blockly] workspace not initialized');
    return;
  }
  blocklyVariables = {}; // сброс переменных
  const topBlocks = blocklyWorkspace.getTopBlocks(true);
  console.log('[nezar-blockly] running ' + topBlocks.length + ' top block(s)');

  for (const block of topBlocks) {
    await execChain(block);
  }
  console.log('[nezar-blockly] execution complete');
}

// ============================================================
// Инициализация Blockly workspace
// ============================================================

function initBlockly() {
  if (blocklyInitialized) {
    Blockly.svgResize(blocklyWorkspace);
    return;
  }
  const workspaceDiv = document.getElementById('blockly-workspace');
  const toolbox = document.getElementById('blockly-toolbox');
  if (!workspaceDiv || !toolbox) return;

  try {
    blocklyWorkspace = Blockly.inject(workspaceDiv, {
      toolbox: toolbox,
      renderer: 'zelos',
      move: { scrollbars: { horizontal: true, vertical: true }, drag: true, wheel: true },
      zoom: { controls: true, wheel: true, startScale: 0.85, maxScale: 2, minScale: 0.3 },
      grid: { spacing: 20, length: 1, colour: 'rgba(255,255,255,0.05)', snap: false },
      theme: 'dark',
    });
    blocklyInitialized = true;
    window.addEventListener('resize', () => {
      if (blocklyWorkspace && document.getElementById('blockly-panel') && document.getElementById('blockly-panel').style.display !== 'none') {
        Blockly.svgResize(blocklyWorkspace);
      }
    });
    console.log('[nezar-blockly] workspace initialized');
  } catch (err) {
    console.error('[nezar-blockly] init error:', err);
  }
}

// ============================================================
// Toggle панели
// ============================================================

function toggleBlocklyPanel() {
  const panel = document.getElementById('blockly-panel');
  const toggleBtn = document.getElementById('blockly-toggle');
  const view = document.getElementById('view-new-project');
  if (!panel || !toggleBtn) return;
  if (panel.style.display !== 'none') {
    panel.style.display = 'none';
    toggleBtn.classList.remove('active');
    view.classList.remove('blockly-open');
  } else {
    panel.style.display = 'flex';
    toggleBtn.classList.add('active');
    view.classList.add('blockly-open');
    initBlockly();
    setTimeout(() => { if (blocklyWorkspace) Blockly.svgResize(blocklyWorkspace); }, 100);
  }
}

// ============================================================
// Сохранение/загрузка состояния блоков
// ============================================================

function saveBlocklyState() {
  if (!blocklyWorkspace) return null;
  try { return JSON.stringify(Blockly.serialization.workspaces.save(blocklyWorkspace)); }
  catch (e) { return null; }
}

function loadBlocklyState(jsonStr) {
  if (!blocklyWorkspace || !jsonStr) return;
  try { Blockly.serialization.workspaces.load(JSON.parse(jsonStr), blocklyWorkspace); }
  catch (e) { console.error('[nezar-blockly] load error:', e); }
}

// ============================================================
// Events
// ============================================================

(function() {
  const toggleBtn = document.getElementById('blockly-toggle');
  const closeBtn = document.getElementById('blockly-panel-close');
  const runBtn = document.getElementById('blockly-run-btn');
  if (toggleBtn) toggleBtn.addEventListener('click', toggleBlocklyPanel);
  if (closeBtn) closeBtn.addEventListener('click', toggleBlocklyPanel);
  if (runBtn) runBtn.addEventListener('click', runBlockly);
  console.log('[nezar-blockly] events wired');
})();
