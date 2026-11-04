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
    "message0": "выполнить vscode %1 вывод в %2",
    "args0": [
      { "type": "input_value", "name": "TEXT", "check": "String" },
      { "type": "input_value", "name": "VAR", "check": "String" }
    ],
    "previousStatement": null,
    "nextStatement": null,
    "colour": "#67FECC",
    "tooltip": "Выполнить команду. Вывод записывается в переменную."
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

async function nezarSendToVSCode(text, varName) {
  if (!activeProject || !isConfigured()) return;
  const requestId = generateRequestId();
  const now = Date.now();
  await addHistoryEntry({ role: 'user', text: text, timestamp: now, status: 'ok', requestId });
  await postRecord({ text: text, timestamp: now, source: 'blockly', requestId });
  const response = await waitForResponse(requestId, 60000);
  if (response) {
    const output = response.output || '(нет вывода)';
    blocklyVscodeOutput = output;
    // Запись вывода в переменную
    if (varName) {
      blocklyVariables[varName] = output;
      console.log('[nezar-blockly] VSCode output → "' + varName + '" = "' + output.slice(0,60) + '"');
    }
    const exitCode = response.exitCode;
    const hasError = response.error || (typeof exitCode === 'number' && exitCode !== 0);
    await addHistoryEntry({
      role: 'assistant',
      text: output,
      timestamp: response.timestamp || Date.now(),
      status: hasError ? 'err' : 'ok',
      exitCode,
      error: response.error,
      requestId,
    });
  } else {
    blocklyVscodeOutput = '(таймаут)';
    if (varName) blocklyVariables[varName] = '(таймаут)';
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

  // Кастомные value-блоки
  if (t === 'nezar_prompt') return blocklyPromptText;
  if (t === 'nezar_text') return block.getFieldValue('TEXT') || '';
  if (t === 'nezar_join') {
    return String(evalBlock(block.getInputTargetBlock('A'))) + String(evalBlock(block.getInputTargetBlock('B')));
  }

  // Стандартные Blockly переменные (variables_get)
  if (t === 'variables_get') {
    const varField = block.getField('VAR');
    let name = '';
    // Способ 1: getText() поля — возвращает отображаемое имя переменной
    if (varField && varField.getText) {
      name = varField.getText();
    }
    // Способ 2: если getText не дал имя, пробуем через getVariableById
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
    console.log('[nezar-blockly] variables_get name="' + name + '" val="' + String(val).slice(0, 60) + '"');
    return val;
  }

  // Стандартные текстовые блоки
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

  // Математика (круглые блоки — для чисел)
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

  // Логика (стандартные Blockly блоки)
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
    const url = readStr('URL') || 'https://chat.deepseek.com';
    // VAR — читаем ИМЯ переменной (не значение!)
    let varName = '';
    const varBlock = block.getInputTargetBlock('VAR');
    if (varBlock) {
      if (varBlock.type === 'variables_get') {
        // Берём имя переменной напрямую из поля
        const vf = varBlock.getField('VAR');
        varName = vf && vf.getText ? vf.getText() : '';
      } else {
        // Если не variables_get — читаем как текст
        varName = String(evalBlock(varBlock));
      }
    }
    if (!varName) varName = 'ai_result';
    console.log('[nezar-blockly] → DeepSeek text=' + text.slice(0,60) + ' url=' + url + ' varName="' + varName + '"');
    await nezarSendToDeepSeek(text, url, varName);
  } else if (t === 'nezar_send_vscode') {
    const text = readStr('TEXT');
    let varName = '';
    const varBlock = block.getInputTargetBlock('VAR');
    if (varBlock) {
      if (varBlock.type === 'variables_get') {
        const vf = varBlock.getField('VAR');
        varName = vf && vf.getText ? vf.getText() : '';
      } else {
        varName = String(evalBlock(varBlock));
      }
    }
    console.log('[nezar-blockly] → VSCode text=' + text.slice(0,60) + ' varName="' + varName + '"');
    await nezarSendToVSCode(text, varName);
  } else if (t === 'nezar_print') {
    const text = readStr('TEXT');
    if (activeProject) {
      await addHistoryEntry({ role: 'ai', text: text, timestamp: Date.now(), status: 'ok', nodeName: 'blockly' });
    }
  } else if (t === 'nezar_set_var') {
    // Кастомный set_var (если используется) — через input_value
    const name = readStr('NAME');
    const val = readStr('VALUE');
    blocklyVariables[name] = val;
    console.log('[nezar-blockly] set_var ' + name + ' = "' + val.slice(0,60) + '"');
  } else if (t === 'variables_set') {
    // Стандартный Blockly variables_set
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
    const val = evalBlock(block.getInputTargetBlock('VALUE'));
    blocklyVariables[name] = val;
    console.log('[nezar-blockly] variables_set name="' + name + '" = "' + String(val).slice(0,60) + '"');
  } else if (t === 'controls_if') {
    // Стандартный Blockly controls_if — если/иначе если/иначе
    let i = 0;
    while (true) {
      const ifInput = block.getInput('IF' + i);
      if (!ifInput) break;
      const condBlock = ifInput.connection && ifInput.connection.targetBlock();
      const cond = evalBlock(condBlock);
      console.log('[nezar-blockly] if[' + i + '] cond=' + cond);
      if (cond) {
        const doBlock = block.getInputTargetBlock('DO' + i);
        if (doBlock) await execChain(doBlock);
        return;
      }
      i++;
    }
    // else
    const elseBlock = block.getInputTargetBlock('ELSE');
    if (elseBlock) await execChain(elseBlock);
  } else if (t === 'controls_repeat_ext') {
    // Стандартный: повторить N раз
    const times = Math.floor(Number(evalBlock(block.getInputTargetBlock('TIMES')))) || 0;
    const doBlock = block.getInputTargetBlock('DO');
    console.log('[nezar-blockly] repeat ' + times + ' times');
    for (let i = 0; i < times && i < 1000; i++) {
      if (doBlock) await execChain(doBlock);
    }
  } else if (t === 'controls_whileUntil') {
    // Стандартный: пока / пока не
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
  // Восстанавливаем сохранённые переменные проекта
  if (activeProject && activeProject.blocklyVariables) {
    blocklyVariables = Object.assign({}, activeProject.blocklyVariables);
    console.log('[nezar-blockly] restored variables:', Object.keys(blocklyVariables));
  }
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
    // Сохраняем переменные И блоки в активный проект (IndexedDB)
    if (activeProject) {
      if (Object.keys(blocklyVariables).length > 0) {
        activeProject.blocklyVariables = Object.assign({}, blocklyVariables);
      }
      // Сохраняем XML блоков
      if (blocklyWorkspace) {
        try {
          const xml = Blockly.serialization.workspaces.save(blocklyWorkspace);
          activeProject.blocklyWorkspace = JSON.stringify(xml);
        } catch(e) { console.error('[nezar-blockly] save workspace:', e); }
      }
      try { await dbUpdateProject(activeProject); } catch(e) { console.error('[nezar-blockly] save:', e); }
      console.log('[nezar-blockly] variables + blocks saved to project');
    }
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
// Сохранение/загрузка блоков per-project
// ============================================================

// Сохраняет текущее состояние workspace в activeProject
function saveBlocklyState() {
  if (!blocklyWorkspace || !activeProject) return;
  try {
    const state = Blockly.serialization.workspaces.save(blocklyWorkspace);
    activeProject.blocklyWorkspace = JSON.stringify(state);
    console.log('[nezar-blockly] saveBlocklyState: saved to project', activeProject.id);
  } catch(e) {
    console.error('[nezar-blockly] saveBlocklyState:', e);
  }
}

// Загружает блоки из проекта в workspace
function loadBlocklyStateForProject(project) {
  if (!blocklyWorkspace || !project) return;
  // Очищаем текущие блоки
  blocklyWorkspace.clear();
  // Загружаем сохранённые
  if (project.blocklyWorkspace) {
    try {
      const state = JSON.parse(project.blocklyWorkspace);
      Blockly.serialization.workspaces.load(state, blocklyWorkspace);
      console.log('[nezar-blockly] loadBlocklyStateForProject: loaded', project.id);
    } catch(e) {
      console.error('[nezar-blockly] loadBlocklyStateForProject:', e);
    }
  } else {
    console.log('[nezar-blockly] loadBlocklyStateForProject: empty workspace for', project.id);
  }
  Blockly.svgResize(blocklyWorkspace);
}

// Копирование всех блоков в буфер обмена (chrome.storage.local)
function copyAllBlocks() {
  if (!blocklyWorkspace) return;
  try {
    const state = Blockly.serialization.workspaces.save(blocklyWorkspace);
    if (chrome && chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({ blocklyClipboard: JSON.stringify(state) });
    }
    console.log('[nezar-blockly] copyAllBlocks: copied');
    return true;
  } catch(e) {
    console.error('[nezar-blockly] copyAllBlocks:', e);
    return false;
  }
}

// Вставка блоков из буфера обмена
function pasteAllBlocks() {
  if (!blocklyWorkspace) return;
  if (!chrome || !chrome.storage || !chrome.storage.local) return;
  chrome.storage.local.get(['blocklyClipboard'], (stored) => {
    if (!stored.blocklyClipboard) {
      console.log('[nezar-blockly] pasteAllBlocks: clipboard empty');
      return;
    }
    try {
      const state = JSON.parse(stored.blocklyClipboard);
      // Не очищаем — добавляем к существующим
      Blockly.serialization.workspaces.append(state, blocklyWorkspace);
      console.log('[nezar-blockly] pasteAllBlocks: pasted');
      Blockly.svgResize(blocklyWorkspace);
    } catch(e) {
      console.error('[nezar-blockly] pasteAllBlocks:', e);
    }
  });
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
  const resizer = document.getElementById('np-resizer');
  if (!panel || !toggleBtn) return;
  if (panel.style.display !== 'none') {
    panel.style.display = 'none';
    toggleBtn.classList.remove('active');
    view.classList.remove('blockly-open');
    if (resizer) resizer.style.display = 'none';
  } else {
    panel.style.display = 'flex';
    toggleBtn.classList.add('active');
    view.classList.add('blockly-open');
    if (resizer) resizer.style.display = 'block';
    initBlockly();
    // Восстанавливаем сохранённую ширину
    if (chrome && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get(['blocklyWidth'], (s) => {
        if (s.blocklyWidth) {
          document.documentElement.style.setProperty('--blockly-width', s.blocklyWidth + 'px');
        }
      });
    }
    setTimeout(() => {
      if (blocklyWorkspace) {
        Blockly.svgResize(blocklyWorkspace);
        // Восстанавливаем блоки из активного проекта
        loadBlocklyStateForProject(activeProject);
      }
    }, 150);
  }
}

// ============================================================
// Ресайзер — тянуть за край чтобы изменить размер панели
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
    // Ограничения: минимум 250px, максимум 80% ширины
    const clamped = Math.max(250, Math.min(newWidth, rect.width * 0.8));
    document.documentElement.style.setProperty('--blockly-width', clamped + 'px');
    if (blocklyWorkspace) Blockly.svgResize(blocklyWorkspace);
  });

  document.addEventListener('mouseup', () => {
    if (!isResizing) return;
    isResizing = false;
    resizer.classList.remove('active');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    // Сохраняем ширину
    const width = document.documentElement.style.getPropertyValue('--blockly-width');
    if (width && chrome && chrome.storage && chrome.storage.local) {
      const px = parseInt(width);
      if (px) chrome.storage.local.set({ blocklyWidth: px });
    }
  });
})();

(function() {
  const toggleBtn = document.getElementById('blockly-toggle');
  const closeBtn = document.getElementById('blockly-panel-close');
  const copyBtn = document.getElementById('blockly-copy-btn');
  const pasteBtn = document.getElementById('blockly-paste-btn');
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
  console.log('[nezar-blockly] events wired');
})();
