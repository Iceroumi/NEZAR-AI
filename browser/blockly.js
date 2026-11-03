/*
 * blockly.js — Blockly workspace для NEZAR.
 * Все слоты — квадратные (String type). Никаких круглых (Number) блоков.
 */

let blocklyWorkspace = null;
let blocklyInitialized = false;
let blocklyVariables = {};
let blocklySkills = {};
let blocklyPromptText = '';
let blocklyVscodeOutput = '';

// ============================================================
// Блоки — все output/inputs только String (квадратная форма)
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
    "type": "nezar_send_vscode",
    "message0": "выполнить vscode %1",
    "args0": [
      { "type": "input_value", "name": "TEXT", "check": "String" }
    ],
    "previousStatement": null,
    "nextStatement": null,
    "colour": "#67FECC",
    "tooltip": "Выполнить команду в VSCode терминале"
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
    "type": "nezar_set_var",
    "message0": "установить %1 = %2",
    "args0": [
      { "type": "input_value", "name": "NAME", "check": "String" },
      { "type": "input_value", "name": "VALUE", "check": "String" }
    ],
    "previousStatement": null,
    "nextStatement": null,
    "colour": "#a55b80",
    "tooltip": "Сохранить значение в переменную"
  }
]);

// ============================================================
// Функции отправки
// ============================================================

async function nezarSendToDeepSeek(text, url, varName) {
  console.log('[nezar-blockly] DeepSeek:', text.slice(0, 60), '→ var:', varName);
  const tabResp = await chrome.runtime.sendMessage({ action: 'find_tab_by_url', url: url });
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
  if (!sendResp || !sendResp.ok) {
    blocklyVariables[varName] = '(ошибка отправки)';
    return;
  }
  const aiResp = await waitForAIResponse(90000);
  if (aiResp && aiResp.text) {
    blocklyVariables[varName] = aiResp.text;
  } else {
    blocklyVariables[varName] = '(таймаут AI)';
  }
}

async function nezarSendToVSCode(text) {
  if (!activeProject || !isConfigured()) return;
  const requestId = generateRequestId();
  const now = Date.now();
  await addHistoryEntry({ role: 'user', text: text, timestamp: now, status: 'ok', requestId });
  await postRecord({ text: text, timestamp: now, source: 'blockly', requestId });
  const response = await waitForResponse(requestId, 60000);
  if (response) {
    blocklyVscodeOutput = response.output || '(нет вывода)';
    const exitCode = response.exitCode;
    const hasError = response.error || (typeof exitCode === 'number' && exitCode !== 0);
    await addHistoryEntry({
      role: 'assistant',
      text: response.output || '(нет вывода)',
      timestamp: response.timestamp || Date.now(),
      status: hasError ? 'err' : 'ok',
      exitCode,
      error: response.error,
      requestId,
    });
  } else {
    blocklyVscodeOutput = '(таймаут)';
    await addHistoryEntry({ role: 'assistant', text: '(таймаут)', timestamp: Date.now(), status: 'err', requestId });
  }
}

// ============================================================
// Интерпретатор
// ============================================================

function evalBlock(block) {
  if (!block) return '';
  const t = block.type;
  console.log('[nezar-blockly] evalBlock:', t);

  if (t === 'nezar_prompt') return blocklyPromptText;
  if (t === 'nezar_text') return block.getFieldValue('TEXT') || '';
  if (t === 'nezar_join') {
    return String(evalBlock(block.getInputTargetBlock('A'))) + String(evalBlock(block.getInputTargetBlock('B')));
  }
  if (t === 'nezar_get_var') {
    const nameBlock = block.getInputTargetBlock('NAME');
    const name = nameBlock ? String(evalBlock(nameBlock)) : (block.getFieldValue('NAME') || '');
    const val = String(blocklyVariables[name] || '');
    console.log('[nezar-blockly] get_var name=' + name + ' val=' + val.slice(0, 60));
    return val;
  }

  console.warn('[nezar-blockly] evalBlock unknown:', t);
  return '';
}

async function execBlock(block) {
  if (!block) return;
  const t = block.type;
  console.log('[nezar-blockly] execBlock:', t);

  // Универсальный читатель String из input_value слота
  const readStr = (inputName) => {
    const b = block.getInputTargetBlock(inputName);
    if (!b) { console.log('[nezar-blockly] readStr ' + inputName + ': NULL (нет блока)'); return ''; }
    const val = String(evalBlock(b));
    console.log('[nezar-blockly] readStr ' + inputName + ': "' + val.slice(0, 80) + '"');
    return val;
  };

  if (t === 'nezar_send_deepseek') {
    const text = readStr('TEXT');
    const url = readStr('URL');
    const varName = readStr('VAR');
    console.log('[nezar-blockly] → DeepSeek text=' + text.slice(0,60) + ' url=' + url + ' var=' + varName);
    await nezarSendToDeepSeek(text, url, varName);
  } else if (t === 'nezar_send_vscode') {
    const text = readStr('TEXT');
    console.log('[nezar-blockly] → VSCode text=' + text.slice(0,60));
    await nezarSendToVSCode(text);
  } else if (t === 'nezar_print') {
    const text = readStr('TEXT');
    if (activeProject) {
      await addHistoryEntry({ role: 'ai', text: text, timestamp: Date.now(), status: 'ok', nodeName: 'blockly' });
    }
  } else if (t === 'nezar_set_var') {
    const name = readStr('NAME');
    const val = readStr('VALUE');
    blocklyVariables[name] = val;
    console.log('[nezar-blockly] set_var ' + name + ' = "' + val.slice(0,60) + '"');
  } else if (t === 'nezar_skill') {
    const name = readStr('NAME');
    const doBlock = block.getInputTargetBlock('DO');
    blocklySkills[name] = doBlock;
    console.log('[nezar-blockly] skill defined: ' + name);
  } else if (t === 'nezar_call_skill') {
    const name = readStr('NAME');
    const doBlock = blocklySkills[name];
    if (doBlock) {
      console.log('[nezar-blockly] calling skill: ' + name);
      await execChain(doBlock);
    } else {
      console.warn('[nezar-blockly] skill NOT FOUND: ' + name);
    }
  } else {
    console.warn('[nezar-blockly] execBlock unknown:', t);
  }
}

async function execChain(block) {
  while (block) {
    await execBlock(block);
    block = block.getNextBlock();
  }
}

// ============================================================
// Запуск
// ============================================================

async function runBlockly(promptText) {
  if (!blocklyWorkspace) {
    console.log('[nezar-blockly] runBlockly: workspace NULL — trying init');
    initBlockly();
    if (!blocklyWorkspace) {
      console.log('[nezar-blockly] runBlockly: init failed, abort');
      return false;
    }
  }
  blocklyVariables = {};
  blocklySkills = {};
  blocklyPromptText = promptText || '';
  blocklyVscodeOutput = '';

  const topBlocks = blocklyWorkspace.getTopBlocks(true);
  console.log('[nezar-blockly] runBlockly: topBlocks=' + topBlocks.length, topBlocks.map(b => b.type));
  if (topBlocks.length === 0) {
    console.log('[nezar-blockly] runBlockly: no blocks, abort');
    return false;
  }

  console.log('[nezar-blockly] running, prompt="' + promptText.slice(0, 60) + '"');

  if (promptText && activeProject) {
    await addHistoryEntry({ role: 'user', text: promptText, timestamp: Date.now(), status: 'ok', requestId: 'blockly_' + Date.now() });
  }

  try {
    for (const block of topBlocks) {
      await execChain(block);
    }
    console.log('[nezar-blockly] done OK');
  } catch (err) {
    console.error('[nezar-blockly] runBlockly ERROR:', err.message, err.stack);
  }
  return true;
}

function hasBlocks() {
  if (!blocklyWorkspace) {
    console.log('[nezar-blockly] hasBlocks: workspace is NULL');
    return false;
  }
  const blocks = blocklyWorkspace.getTopBlocks(false);
  console.log('[nezar-blockly] hasBlocks: topBlocks=' + blocks.length, blocks.map(b => b.type));
  return blocks.length > 0;
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
  if (!workspaceDiv || !toolbox) return;

  try {
    blocklyWorkspace = Blockly.inject(workspaceDiv, {
      toolbox: toolbox,
      renderer: 'zelos',
      horizontalLayout: true,
      toolboxPosition: 'end',
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
    console.log('[nezar-blockly] initialized');
  } catch (err) {
    console.error('[nezar-blockly] init error:', err);
  }
}

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

(function() {
  const toggleBtn = document.getElementById('blockly-toggle');
  const closeBtn = document.getElementById('blockly-panel-close');
  if (toggleBtn) toggleBtn.addEventListener('click', toggleBlocklyPanel);
  if (closeBtn) closeBtn.addEventListener('click', toggleBlocklyPanel);
  console.log('[nezar-blockly] events wired');
})();
