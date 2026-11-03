// content/main.js v0.8 — AI Reactor / Nezar
// Работает на chat.deepseek.com, chat.qwen.ai, chat.z.ai
// 1) Авто-детект сайта
// 2) Конфиг селекторов + isComplete() по флагу завершения
// 3) Принимает inject_and_send (с bindingId)
// 4) Стримит ответ в background с bindingId (чтобы dashboard знал в какую карточку)

(() => {
  'use strict';

  // ============================================================
  // ДЕТЕКТ САЙТА
  // ============================================================
  const SITE = detectSite();
  if (!SITE) return;

  function detectSite() {
    const host = location.hostname;
    if (host.includes('deepseek.com')) return 'deepseek';
    if (host.includes('qwen.ai'))     return 'qwen';
    if (host.includes('z.ai'))        return 'glm';
    return null;
  }

  // ============================================================
  // КОНФИГ СЕЛЕКТОРОВ
  // ============================================================
  const CONFIG = {
    deepseek: {
      editor: [
        'textarea[placeholder="Message DeepSeek"]',
        'textarea[name="search"]',
        'textarea#chat-input',
        'textarea.ds-scroll-area',
        'textarea',
      ],
      sendBtn: [
        'div[role="button"].ds-icon-button',
        'div[role="button"][aria-label*="Send" i]',
        'button[type="submit"]',
        'div[class*="send"]',
      ],
      answer: [
        'div.ds-markdown.ds-assistant-message-main-content',
        '.ds-assistant-message-main-content',
        'div.ds-message:last-of-type .ds-markdown',
      ],
      think: [
        'div.ds-think-content .ds-markdown',
        'div.ds-think-content',
      ],
      isComplete: function(latestAnswerEl) {
        if (!latestAnswerEl) return false;
        const message = latestAnswerEl.closest('.ds-message') ||
                        latestAnswerEl.closest('[class*="ds-message"]') ||
                        latestAnswerEl.parentElement?.parentElement?.parentElement;
        if (!message) return false;
        return !!message.querySelector('div.ds-button__background');
      },
    },

    qwen: {
      editor: [
        'textarea.message-input-textarea',
        'textarea[placeholder*="помощь" i]',
        'textarea[placeholder*="вам сегодня" i]',
        'textarea',
      ],
      sendBtn: [
        'button.send-button[aria-label="Отправить"]',
        'button.send-button',
        'button[aria-label="Отправить"]',
        'button[aria-label*="send" i]',
      ],
      answer: [
        'div.response-message-content.t2t .custom-qwen-markdown',
        'div.response-message-content .custom-qwen-markdown',
        'div.custom-qwen-markdown',
      ],
      think: [
        'div.qwen-chat-thinking-tool-status-card-wraper',
        'div.qwen-chat-thinking-status-card-completed',
      ],
      isComplete: function(latestAnswerEl) {
        if (!latestAnswerEl) return false;
        const message = latestAnswerEl.closest('.chat-response-message-right') ||
                        latestAnswerEl.closest('[class*="response-message"]') ||
                        latestAnswerEl.parentElement?.parentElement?.parentElement?.parentElement;
        if (!message) return false;
        return !!message.querySelector(
          'button[aria-label="Поделиться"], ' +
          'button[aria-label="Share"], ' +
          'button.qwen-chat-package-comp-new-action-control-container-share'
        );
      },
    },

    // ⚠️ ВНИМАНИЕ: GLM/z.ai селекторы — это гипотеза, не проверены на реальном HTML.
    // Если не работает — открой F12 на chat.z.ai после отправки сообщения,
    // найди поле ввода и блок ответа, пришли мне HTML — поправим селекторы.
    glm: {
      editor: [
        'textarea#chat-input',
        'textarea[placeholder*="message" i]',
        'textarea[placeholder*="сообщен" i]',
        'div[contenteditable="true"]',
        'textarea',
      ],
      sendBtn: [
        'button[data-testid="send-button"]',
        'button[aria-label*="send" i]',
        'button[aria-label*="отправ" i]',
        'button[type="submit"]',
        'button.send-button',
      ],
      answer: [
        'div[data-testid="assistant-message"]',
        'div.markdown-body',
        'div[class*="answer-content"]',
        'div[class*="message-content"]',
        'div.prose',
      ],
      think: [
        'div[data-testid="thinking"]',
        'div[class*="thinking"]',
        'div[class*="reasoning"]',
      ],
      isComplete: function(latestAnswerEl) {
        if (!latestAnswerEl) return false;
        // У GLM ищем кнопки действий под ответом (копировать/regenerate)
        const message = latestAnswerEl.closest('[class*="message"]') ||
                        latestAnswerEl.parentElement?.parentElement?.parentElement;
        if (!message) return false;
        // Если нашли кнопки копировать/regenerate — ответ завершён
        return !!message.querySelector(
          'button[aria-label*="копировать" i], ' +
          'button[aria-label*="copy" i], ' +
          'button[aria-label*="regenerate" i], ' +
          'button[aria-label*="заново" i], ' +
          'button[data-testid*="copy" i], ' +
          'button[data-testid*="regenerate" i]'
        );
      },
    },
  };

  const cfg = CONFIG[SITE];

  // ============================================================
  // ИЗВЛЕЧЕНИЕ ТЕКСТА ОТВЕТА (корректное для каждого сайта)
  // ============================================================
  // Извлечение текста ответа с СОХРАНЕНИЕМ ПЕРЕНОСОВ СТРОК.
  // textContent склеивает всё без \n — нужен innerText + DOM-walk.
  function extractAnswerText(el, site) {
    if (!el) return '';

    // Стратегия 1: innerText — учитывает CSS display, добавляет \n для block элементов.
    // Это самый надёжный способ получить текст с переносами.
    try {
      const it = (el.innerText || '').trim();
      if (it && it.length > 0) {
        // Проверяем что есть хотя бы один перенос строки.
        // Если innerText вернул текст БЕЗ \n хотя должен — переходим к DOM-walk.
        if (it.includes('\n')) {
          return it;
        }
        // Нет переносов — возможно DeepSeek использует flex layout.
        // Попробуем DOM-walk ниже.
      }
    } catch (e) { /* innerText может не работать на некоторых элементах */ }

    // Стратегия 2: DOM-walk — обходим дочерние узлы, вставляем \n между block элементами.
    const walked = walkDomForText(el);
    if (walked && walked.length > 0) {
      return walked;
    }

    // Стратегия 3: paragraph-based — объединяем параграфы через \n.
    const blocks = el.querySelectorAll(
      '.qwen-markdown-paragraph, .ds-markdown-paragraph, p, li, h1, h2, h3, h4, h5, h6, pre, code, div'
    );
    if (blocks.length > 1) {
      const parts = Array.from(blocks)
        .map(b => (b.textContent || '').trim())
        .filter(t => t.length > 0);
      if (parts.length > 0) {
        return parts.join('\n');
      }
    }

    // Стратегия 4: textContent (last resort — без переносов, но хоть что-то).
    return (el.textContent || '').trim();
  }

  // DOM-walk: обходит узлы и вставляет \n между block-элементами и <br>.
  const BLOCK_TAGS = new Set([
    'DIV', 'P', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'PRE', 'BLOCKQUOTE', 'TR', 'SECTION', 'ARTICLE', 'UL', 'OL',
    'TABLE', 'THEAD', 'TBODY', 'FOOTER', 'HEADER',
  ]);

  function walkDomForText(root) {
    let result = '';
    let lastWasBlock = false;

    function walk(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent;
        if (text) {
          result += text;
          lastWasBlock = false;
        }
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;

      const tag = node.tagName;
      const isBlock = BLOCK_TAGS.has(tag);
      const isBr = tag === 'BR';

      if (isBr) {
        result += '\n';
        lastWasBlock = true;
        return;
      }

      // Перед block-элементом добавляем \n если ещё не на новой строке.
      if (isBlock && result.length > 0 && !result.endsWith('\n')) {
        result += '\n';
      }

      // Обходим детей.
      for (const child of node.childNodes) {
        walk(child);
      }

      // После block-элемента добавляем \n.
      if (isBlock && result.length > 0 && !result.endsWith('\n')) {
        result += '\n';
      }

      lastWasBlock = isBlock;
    }

    walk(root);

    // Очищаем: убираем множественные пустые строки, trim.
    return result
      .replace(/\r\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // ============================================================
  // ПОИСК ЭЛЕМЕНТОВ
  // ============================================================
  function findEditor() {
    for (const sel of cfg.editor) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  function findAnswerElements() {
    const result = [];
    const seen = new Set();

    // 1. Специфичные селекторы из конфига (быстрые, но хрупкие).
    for (const sel of cfg.answer) {
      document.querySelectorAll(sel).forEach(el => {
        if (!seen.has(el)) {
          seen.add(el);
          result.push(el);
        }
      });
    }

    // 2. Broad fallback — ищем элементы, похожие на ответ AI.
    // Если специфичные селекторы не сработали, пробуем широкие.
    if (result.length === 0) {
      const broadSelectors = [
        // DeepSeek-подобные классы
        'div[class*="ds-assistant"]',
        'div[class*="ds-message"]',
        'div[class*="ds-markdown"]',
        // Общие паттерны чат-ответов
        'div[class*="assistant-message"]',
        'div[class*="message-content"]',
        'div[class*="answer-content"]',
        'div[class*="response-message"]',
        'div[class*="markdown-body"]',
        'div[class*="prose"]',
        // Роль-based
        'div[data-role="assistant"]',
        'div[data-message-author-role="assistant"]',
        // Очень broad — любой div с >100 символами текста (фильтруем ниже)
      ];
      for (const sel of broadSelectors) {
        document.querySelectorAll(sel).forEach(el => {
          if (seen.has(el)) return;
          const text = (el.textContent || '').trim();
          if (text.length > 50) { // только substantial элементы
            seen.add(el);
            result.push(el);
            console.log('[nezar-content] broad selector matched:', sel, 'textLen=' + text.length);
          }
        });
      }
    }

    console.log('[nezar-content] findAnswerElements: found ' + result.length + ' elements');
    return result;
  }

  // Very broad fallback: находит последний большой текстовый блок на странице.
  // Используется когда ВСЕ селекторы не сработали.
  function findAnswerVeryBroad() {
    const allDivs = document.querySelectorAll('div, section, article');
    let best = null;
    let bestLen = 0;
    for (const el of allDivs) {
      // Пропускаем маленькие элементы и элементы ввода
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') continue;
      const ownText = (el.textContent || '').trim();
      // Ищем элементы с substantial текстом, но без слишком многих детей
      // (чтобы не взять весь body)
      if (ownText.length > 100 && ownText.length > bestLen && el.children.length < 20) {
        best = el;
        bestLen = ownText.length;
      }
    }
    if (best) {
      console.log('[nezar-content] findAnswerVeryBroad: found element with ' + bestLen + ' chars');
    }
    return best;
  }

  // Получает текст всей области чата (для diff-обнаружения).
  function getChatAreaText() {
    // Пытаемся найти контейнер чата.
    const containers = [
      'div[class*="chat"]',
      'div[class*="conversation"]',
      'div[class*="messages"]',
      'main',
      '#chat',
      'div[role="log"]',
      'div[role="main"]',
    ];
    for (const sel of containers) {
      const el = document.querySelector(sel);
      if (el && el.textContent) {
        return el.textContent.trim();
      }
    }
    // Fallback: весь body
    return document.body ? document.body.textContent.trim() : '';
  }

  function findLatestThink() {
    for (const sel of cfg.think) {
      const list = document.querySelectorAll(sel);
      if (list.length > 0) return list[list.length - 1];
    }
    return null;
  }

  // ============================================================
  // ВСТАВКА ТЕКСТА
  // ============================================================
  function setEditorText(el, text) {
    el.focus();
    if (el.isContentEditable) {
      el.innerText = text;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
      return;
    }
    const proto = window.HTMLTextAreaElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, text);
    else el.value = text;
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function sendViaEnter(el) {
    const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, shiftKey: false };
    el.dispatchEvent(new KeyboardEvent('keydown',  opts));
    el.dispatchEvent(new KeyboardEvent('keypress', opts));
    el.dispatchEvent(new KeyboardEvent('keyup',    opts));
  }

  function tryClickSendButton() {
    for (const sel of cfg.sendBtn) {
      const el = document.querySelector(sel);
      if (el) {
        el.click();
        return true;
      }
    }
    return false;
  }

  function trySubmitForm(el) {
    const form = el.closest('form');
    if (form) {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      return true;
    }
    return false;
  }

  // ============================================================
  // СТРИМ ОТВЕТА
  // ============================================================
  let streamingTimer = null;
  let fallbackTimer = null;
  let mutationObserver = null;
  let lastSentText = '';
  let knownAnswerCount = 0;
  let currentBindingId = null;
  let stableCount = 0; // сколько раз подряд текст не менялся (для определения завершения)

  function stopStreaming() {
    if (streamingTimer) { clearInterval(streamingTimer); streamingTimer = null; }
    if (fallbackTimer) { clearTimeout(fallbackTimer); fallbackTimer = null; }
    if (mutationObserver) { mutationObserver.disconnect(); mutationObserver = null; }
    lastSentText = '';
    stableCount = 0;
  }

  function startStreaming(bindingId) {
    stopStreaming();
    currentBindingId = bindingId || null;
    console.log('[nezar-content] startStreaming START, bindingId=' + bindingId + ', site=' + SITE);

    const existing = findAnswerElements();
    knownAnswerCount = existing.length;
    const initialChatText = getChatAreaText();
    const initialChatLen = initialChatText.length;
    console.log('[nezar-content] existing answers:', knownAnswerCount, 'initial chat text len:', initialChatLen);

    sendToBg({ action: 'answer_chunk', site: SITE, bindingId: currentBindingId, phase: 'waiting', text: '', think: '' });

    let foundNew = false;
    let tickCount = 0;
    let cachedAnswerEl = null; // кэш найденного элемента ответа — не ищем заново каждый poll

    // Основная функция проверки — вызывается и по таймеру, и по MutationObserver.
    function checkForAnswer() {
      tickCount++;

      // --- ФАЗА 1: ищем появление нового ответа ---
      if (!foundNew) {
        const answers = findAnswerElements();
        // Стратегия A: больше answer-элементов чем было
        if (answers.length > knownAnswerCount) {
          foundNew = true;
          cachedAnswerEl = answers[answers.length - 1]; // кэшируем!
          knownAnswerCount = answers.length;
          console.log('[nezar-content] NEW answer (strategy A: more elements)! count=' + answers.length + ' cached element:', cachedAnswerEl?.tagName, cachedAnswerEl?.className?.slice(0,60));
          sendToBg({ action: 'answer_chunk', site: SITE, bindingId: currentBindingId, phase: 'streaming', text: '', think: '' });
          return;
        }
        // Стратегия B: текст последнего элемента изменился
        if (answers.length > 0) {
          const last = answers[answers.length - 1];
          const txt = extractAnswerText(last, SITE);
          if (txt && txt !== lastSentText && txt.length > 10) {
            foundNew = true;
            cachedAnswerEl = last; // кэшируем!
            knownAnswerCount = answers.length;
            console.log('[nezar-content] NEW answer (strategy B: new text)! textLen=' + txt.length + ' cached element:', last?.tagName, last?.className?.slice(0,60));
            lastSentText = txt;
            sendToBg({ action: 'answer_chunk', site: SITE, bindingId: currentBindingId, phase: 'streaming', text: txt, think: '' });
            return;
          }
        }
        // Стратегия C: chat area text вырос значительно (diff-based)
        const currentChatText = getChatAreaText();
        if (currentChatText.length > initialChatLen + 100) {
          console.log('[nezar-content] chat area grew: ' + initialChatLen + ' → ' + currentChatText.length);
          const broadEl = findAnswerVeryBroad();
          if (broadEl) {
            const broadText = extractAnswerText(broadEl, SITE);
            if (broadText && broadText.length > 20) {
              foundNew = true;
              cachedAnswerEl = broadEl; // кэшируем!
              console.log('[nezar-content] NEW answer (strategy C: very broad)! textLen=' + broadText.length);
              lastSentText = broadText;
              sendToBg({ action: 'answer_chunk', site: SITE, bindingId: currentBindingId, phase: 'streaming', text: broadText, think: '' });
              return;
            }
          }
        }
        if (tickCount % 10 === 0) {
          console.log('[nezar-content] waiting... tick=' + tickCount + ' answers=' + answers.length + ' known=' + knownAnswerCount + ' chatLen=' + currentChatText.length);
        }
        return;
      }

      // --- ФАЗА 2: стримим текст ответа (из кэшированного элемента) ---
      // Используем кэшированный элемент, не ищем заново — это стабилизирует текст.
      // Если элемент удалился из DOM (DeepSeek перерисовал), ищем заново.
      if (!cachedAnswerEl || !document.contains(cachedAnswerEl)) {
        console.log('[nezar-content] cached element lost, re-finding...');
        const answers = findAnswerElements();
        cachedAnswerEl = answers.length > 0 ? answers[answers.length - 1] : null;
        if (!cachedAnswerEl) {
          cachedAnswerEl = findAnswerVeryBroad();
        }
        if (cachedAnswerEl) {
          console.log('[nezar-content] re-found element:', cachedAnswerEl?.tagName, cachedAnswerEl?.className?.slice(0,60));
        }
      }

      let text = '';
      if (cachedAnswerEl) {
        text = extractAnswerText(cachedAnswerEl, SITE);
      }

      if (!text) {
        // Текст пустой — не инкрементируем stableCount, но и не сбрасываем.
        // Просто ждём дальше.
        if (tickCount % 10 === 0) console.log('[nezar-content] phase 2: text empty, waiting... tick=' + tickCount);
        return;
      }

      const thinkEl = findLatestThink();
      const think = thinkEl ? extractAnswerText(thinkEl, SITE) : '';

      // Отправляем чанк если текст изменился
      if (text !== lastSentText) {
        lastSentText = text;
        stableCount = 0;
        console.log('[nezar-content] streaming chunk: textLen=' + text.length + ' stableCount=' + stableCount + ' (reset: text changed)');
        sendToBg({ action: 'answer_chunk', site: SITE, bindingId: currentBindingId, phase: 'streaming', text: text, think: think });
      } else {
        // Текст не изменился с прошлой проверки
        stableCount++;
        console.log('[nezar-content] text stable, stableCount=' + stableCount + '/4 (need 4 for completion)');
      }

      // --- ПРОВЕРКА ЗАВЕРШЕНИЯ ---
      // Способ 1: isComplete из конфига
      let isDone = false;
      if (cachedAnswerEl && cfg.isComplete) {
        try {
          isDone = cfg.isComplete(cachedAnswerEl);
        } catch (e) {
          // ignore
        }
      }

      // Способ 2: text-stability — текст не менялся 4 проверки подряд (~2 сек)
      if (!isDone && stableCount >= 4 && text.length > 0) {
        console.log('[nezar-content] COMPLETE (text stability: unchanged for 4 checks = ~2sec)');
        isDone = true;
      }

      if (isDone) {
        console.log('[nezar-content] COMPLETE! textLen=' + text.length + ' thinkLen=' + think.length);
        console.log('[nezar-content] FINAL TEXT (first 300 chars):', text.slice(0, 300));
        sendToBg({ action: 'answer_complete', site: SITE, bindingId: currentBindingId, text: text, think: think });
        stopStreaming();
      }
    }

    // MutationObserver — мгновенно реагирует на изменения DOM (быстрее polling).
    try {
      mutationObserver = new MutationObserver(() => {
        // Не вызываем checkForAnswer слишком часто — debounce.
        if (streamingTimer) return; // polling ещё работает, MutationObserver только ускоряет
        checkForAnswer();
      });
      mutationObserver.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
      });
      console.log('[nezar-content] MutationObserver started');
    } catch (e) {
      console.log('[nezar-content] MutationObserver failed (non-critical):', e.message);
    }

    // Polling каждые 500мс — основной механизм проверки.
    streamingTimer = setInterval(checkForAnswer, 500);
    console.log('[nezar-content] polling started (500ms interval)');

    // Запасной таймаут 45 сек — отправляет что есть.
    // 45 < 90 (таймаут dashboard) — успеет отправить ответ до таймаута dashboard.
    fallbackTimer = setTimeout(() => {
      if (streamingTimer || mutationObserver) {
        console.log('[nezar-content] TIMEOUT (45s) — sending whatever we have');
        const answers = findAnswerElements();
        let latest = answers.length > 0 ? answers[answers.length - 1] : null;
        let text = latest ? extractAnswerText(latest, SITE) : lastSentText;
        // Very broad fallback
        if (!text || text.length === 0) {
          const broadEl = findAnswerVeryBroad();
          if (broadEl) text = extractAnswerText(broadEl, SITE);
        }
        const thinkEl = findLatestThink();
        const think = thinkEl ? extractAnswerText(thinkEl, SITE) : '';
        if (!text) text = '(ответ не обнаружен — проверьте селекторы в content/main.js)';
        sendToBg({
          action: 'answer_complete',
          site: SITE,
          bindingId: currentBindingId,
          text: text,
          think: think,
          note: 'completed-by-timeout',
        });
        stopStreaming();
      }
    }, 45000);
  }

  function sendToBg(payload) {
    console.log('[nezar-content] sendToBg:', payload.action, 'phase=' + (payload.phase||''), 'textLen=' + (payload.text||'').length, 'bindingId=' + payload.bindingId);
    try {
      chrome.runtime.sendMessage(payload)
        .then(r => console.log('[nezar-content] sendToBg response:', r))
        .catch(err => console.error('[nezar-content] sendToBg ERROR:', err));
    } catch (e) {
      console.error('[nezar-content] sendToBg exception:', e);
    }
  }

  // ============================================================
  // ГЛАВНАЯ КОМАНДА
  // ============================================================
  async function injectAndSend(text, bindingId) {
    console.log('[nezar-content] injectAndSend START, textLen=' + text.length + ' bindingId=' + bindingId + ' site=' + SITE);
    const editor = await waitForEditor(8000);
    if (!editor) {
      console.error('[nezar-content] editor NOT FOUND');
      return { ok: false, error: 'Поле ввода не найдено' };
    }
    console.log('[nezar-content] editor found:', editor.tagName, editor.className);

    setEditorText(editor, text);
    console.log('[nezar-content] text set in editor');
    await new Promise(r => setTimeout(r, 300));

    sendViaEnter(editor);
    console.log('[nezar-content] Enter sent');
    await new Promise(r => setTimeout(r, 300));
    const clicked = tryClickSendButton();
    console.log('[nezar-content] send button clicked:', clicked);
    await new Promise(r => setTimeout(r, 200));
    const submitted = trySubmitForm(editor);
    console.log('[nezar-content] form submitted:', submitted);

    setTimeout(() => startStreaming(bindingId), 500);

    return { ok: true, method: 'multi', note: 'Запрос отправлен, ждём ответ...' };
  }

  function waitForEditor(timeout) {
    return new Promise(resolve => {
      const start = Date.now();
      (function check() {
        const el = findEditor();
        if (el) return resolve(el);
        if (Date.now() - start > timeout) return resolve(null);
        setTimeout(check, 300);
      })();
    });
  }

  // ============================================================
  // СЛУШАТЕЛЬ
  // ============================================================
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'inject_and_send') {
      injectAndSend(msg.text, msg.bindingId)
        .then(result => sendResponse(result))
        .catch(err => sendResponse({ ok: false, error: err.message }));
      return true;
    }
    if (msg.action === 'cancel_stream') {
      stopStreaming();
      sendResponse({ ok: true });
      return false;
    }
  });

  console.log(`[Nezar v0.8] content script активен на ${SITE}`);
})();
