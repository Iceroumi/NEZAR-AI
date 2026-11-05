/*
 * background.js — service worker Manifest V3.
 *
 * Задачи:
 *   1. При клике по иконке расширения — открыть dashboard.html в новой вкладке.
 *   2. Найти открытую вкладку AI-чата (DeepSeek/Qwen/GLM) для AI-режима.
 *   3. Пересылать промпты из dashboard → content script на AI-вкладке.
 *   4. Пересылать стрим ответов от content script → dashboard.
 *   5. Native Messaging: связь с ОС-терминалом через com.nezar.host.
 */

const AI_HOSTS = ['chat.deepseek.com', 'chat.qwen.ai', 'chat.z.ai'];
const NATIVE_HOST_NAME = 'com.nezar.host';

// ============================================================
// Native Messaging: связь с ОС-терминалом
// ============================================================

// Активные подключения к native host (по reqId).
// Каждое обращение = отдельный порт, чтобы проще было закрывать.
const nativePorts = new Map(); // reqId → chrome.runtime.Port
const nativeResponses = new Map(); // reqId → { stdout, stderr, exitCode, done, error }

// Проверка связи с native host.
async function pingNativeHost() {
  return new Promise((resolve) => {
    let port;
    try {
      port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    } catch (e) {
      resolve({ ok: false, error: 'connectNative failed: ' + e.message });
      return;
    }
    const reqId = 'ping_' + Date.now();
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { port.disconnect(); } catch (e) {}
        resolve({ ok: false, error: 'ping timeout (host не отвечает за 3 сек). Native host установлен?' });
      }
    }, 3000);

    port.onMessage.addListener((msg) => {
      if (msg && msg.type === 'pong' && !settled) {
        settled = true;
        clearTimeout(timer);
        try { port.disconnect(); } catch (e) {}
        resolve({ ok: true, info: msg });
      }
    });
    port.onDisconnect.addListener(() => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        const lastErr = chrome.runtime.lastError;
        resolve({
          ok: false,
          error: 'Native host disconnected. ' + (lastErr ? lastErr.message : 'Возможно не установлен. Запустите install-*.js'),
        });
      }
    });
    try {
      port.postMessage({ id: reqId, type: 'ping' });
    } catch (e) {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        try { port.disconnect(); } catch (err) {}
        resolve({ ok: false, error: 'postMessage failed: ' + e.message });
      }
    }
  });
}

// Запуск команды через native host. Возвращает полный вывод и exit code.
async function runNativeCommand(command, cwd, timeout) {
  return new Promise((resolve) => {
    const reqId = 'cmd_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    let port;
    try {
      port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    } catch (e) {
      resolve({ ok: false, error: 'connectNative failed: ' + e.message });
      return;
    }

    const state = { stdout: '', stderr: '', exitCode: null, done: false, error: null };
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      try { port.disconnect(); } catch (e) {}
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({
        ok: false,
        error: 'Таймаут выполнения (' + (timeout || 60000) + 'ms)',
        stdout: state.stdout,
        stderr: state.stderr,
      });
    }, (timeout || 60000) + 5000); // +5 сек запас сверх таймаута host-а

    port.onMessage.addListener((msg) => {
      if (!msg || msg.id !== reqId) return;
      if (msg.type === 'stdout') {
        state.stdout += msg.text || '';
      } else if (msg.type === 'stderr') {
        state.stderr += msg.text || '';
      } else if (msg.type === 'done') {
        clearTimeout(timer);
        finish({
          ok: true,
          stdout: msg.stdout || state.stdout,
          stderr: msg.stderr || state.stderr,
          exitCode: typeof msg.exitCode === 'number' ? msg.exitCode : 0,
        });
      } else if (msg.type === 'error') {
        clearTimeout(timer);
        finish({
          ok: false,
          error: msg.error || 'native host error',
          stdout: msg.stdout || state.stdout,
          stderr: msg.stderr || state.stderr,
        });
      }
    });

    port.onDisconnect.addListener(() => {
      const lastErr = chrome.runtime.lastError;
      clearTimeout(timer);
      if (!settled) {
        finish({
          ok: false,
          error: 'Native host disconnected unexpectedly. ' + (lastErr ? lastErr.message : ''),
          stdout: state.stdout,
          stderr: state.stderr,
        });
      }
    });

    try {
      port.postMessage({
        id: reqId,
        command: command,
        cwd: cwd || null,
        timeout: timeout || 60000,
      });
    } catch (e) {
      clearTimeout(timer);
      finish({ ok: false, error: 'postMessage failed: ' + e.message });
    }
  });
}

// ============================================================
// Открыть dashboard
// ============================================================
chrome.action.onClicked.addListener((tab) => {
  console.log('[nezar-bg] action clicked — opening dashboard');
  chrome.tabs.create({
    url: chrome.runtime.getURL('dashboard.html'),
  });
});

// ============================================================
// Найти открытую вкладку AI-чата
// ============================================================
async function findAITab() {
  console.log('[nezar-bg] findAITab called');
  const tabs = await chrome.tabs.query({});
  console.log('[nezar-bg] total tabs open:', tabs.length);
  for (const host of AI_HOSTS) {
    const found = tabs.find(t =>
      t.url && t.url.startsWith('https://') &&
      t.url.includes(host) &&
      t.status === 'complete'
    );
    if (found) {
      const site = hostToSite(host);
      console.log('[nezar-bg] AI tab found:', host, 'tabId=' + found.id, 'site=' + site);
      return { ok: true, tabId: found.id, host: host, site: site };
    }
  }
  console.log('[nezar-bg] NO AI tab found among', tabs.length, 'tabs');
  const aiTabs = tabs.filter(t => t.url && AI_HOSTS.some(h => t.url.includes(h)));
  console.log('[nezar-bg] tabs matching AI hosts:', aiTabs.map(t => ({id: t.id, url: t.url, status: t.status})));
  return { ok: false, error: 'Нет открытой вкладки DeepSeek/Qwen/GLM. Откройте chat.deepseek.com.' };
}

function hostToSite(host) {
  if (host.includes('deepseek.com')) return 'deepseek';
  if (host.includes('qwen.ai'))     return 'qwen';
  if (host.includes('z.ai'))        return 'glm';
  return 'unknown';
}

// ============================================================
// Отправить промпт в AI-вкладку через content script
// ============================================================
async function sendToAI(text) {
  console.log('[nezar-bg] sendToAI called, textLen=' + text.length);
  const tabInfo = await findAITab();
  if (!tabInfo.ok) {
    console.log('[nezar-bg] sendToAI: no AI tab');
    return tabInfo;
  }

  console.log('[nezar-bg] sendToAI: sending inject_and_send to tabId=' + tabInfo.tabId);
  try {
    const response = await chrome.tabs.sendMessage(tabInfo.tabId, {
      action: 'inject_and_send',
      text: text,
      site: tabInfo.site,
      bindingId: 'nezar-dashboard',
    });
    console.log('[nezar-bg] sendToAI: content script responded:', JSON.stringify(response));
    return { ok: true, response: response, site: tabInfo.site };
  } catch (err) {
    console.error('[nezar-bg] sendToAI: sendMessage FAILED:', err.message);
    return {
      ok: false,
      error: 'Не удалось связаться с AI-вкладкой. Попробуйте перезагрузить вкладку (F5). ' + err.message,
    };
  }
}

// ============================================================
// Найти все вкладки dashboard
// ============================================================
async function findDashboardTabs() {
  const url = chrome.runtime.getURL('dashboard.html');
  console.log('[nezar-bg] finding dashboard tabs with url:', url);
  const tabs = await chrome.tabs.query({});
  const dashTabs = tabs.filter(t => t.url && t.url.includes(chrome.runtime.getURL('dashboard.html')));
  console.log('[nezar-bg] dashboard tabs found:', dashTabs.map(t => ({id: t.id, url: t.url})));
  return dashTabs;
}

// ============================================================
// Маршрутизация сообщений
// ============================================================
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  console.log('[nezar-bg] MESSAGE:', msg.action, 'from tabId=' + (sender.tab?.id || 'N/A'));

  if (msg.action === 'find_ai_tab') {
    findAITab()
      .then(r => { console.log('[nezar-bg] find_ai_tab response:', r); sendResponse(r); })
      .catch(e => { console.error('[nezar-bg] find_ai_tab error:', e); sendResponse({ ok: false, error: e.message }); });
    return true;
  }

  if (msg.action === 'send_to_ai') {
    sendToAI(msg.text)
      .then(r => { console.log('[nezar-bg] send_to_ai response:', r); sendResponse(r); })
      .catch(e => { console.error('[nezar-bg] send_to_ai error:', e); sendResponse({ ok: false, error: e.message }); });
    return true;
  }

  // content script → background → dashboard: стрим ответов от AI
  if (msg.action === 'answer_chunk' || msg.action === 'answer_complete' || msg.action === 'answer_error') {
    console.log('[nezar-bg] forwarding AI answer:', msg.action, 'phase=' + (msg.phase||''), 'textLen=' + (msg.text||'').length, 'from tabId=' + (sender.tab?.id || 'N/A'));

    findDashboardTabs().then(tabs => {
      console.log('[nezar-bg] forwarding to', tabs.length, 'dashboard tab(s)');
      if (tabs.length === 0) {
        console.error('[nezar-bg] NO DASHBOARD TABS FOUND — answer lost!');
      }
      for (const t of tabs) {
        chrome.tabs.sendMessage(t.id, msg)
          .then(() => console.log('[nezar-bg] forwarded to dashboard tabId=' + t.id + ' OK'))
          .catch(err => console.error('[nezar-bg] forward to tabId=' + t.id + ' FAILED:', err.message));
      }
    }).catch(err => {
      console.error('[nezar-bg] findDashboardTabs error:', err);
    });

    sendResponse({ ok: true });
    return false;
  }

  // dashboard → background: найти вкладку по конкретному URL (для pipeline)
  if (msg.action === 'find_tab_by_url') {
    console.log('[nezar-bg] find_tab_by_url:', msg.url);
    chrome.tabs.query({})
      .then(tabs => {
        const targetUrl = msg.url.split('?')[0].split('#')[0];
        const found = tabs.find(t => {
          if (!t.url || !t.url.startsWith('https://')) return false;
          const tabUrl = t.url.split('?')[0].split('#')[0];
          return tabUrl.includes(targetUrl) || targetUrl.includes(tabUrl);
        });
        if (found) {
          let site = 'unknown';
          try { site = hostToSite(new URL(found.url).hostname); } catch(e) {}
          console.log('[nezar-bg] find_tab_by_url: found tabId=' + found.id + ' site=' + site);
          sendResponse({ ok: true, tabId: found.id, site: site, url: found.url });
        } else {
          console.log('[nezar-bg] find_tab_by_url: NOT found');
          sendResponse({ ok: false, error: 'Вкладка с этим URL не найдена. Откройте чат в браузере.' });
        }
      })
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  // dashboard → background → content script: отправить в КОНКРЕТНУЮ вкладку
  if (msg.action === 'send_to_specific_tab') {
    console.log('[nezar-bg] send_to_specific_tab: tabId=' + msg.tabId + ' textLen=' + (msg.text||'').length);
    chrome.tabs.sendMessage(msg.tabId, {
      action: 'inject_and_send',
      text: msg.text,
      site: msg.site,
      bindingId: msg.bindingId || ('pipeline_' + msg.tabId),
    })
      .then(r => {
        console.log('[nezar-bg] send_to_specific_tab: response:', r);
        sendResponse({ ok: true, response: r });
      })
      .catch(e => {
        console.error('[nezar-bg] send_to_specific_tab: FAILED:', e.message);
        sendResponse({ ok: false, error: 'Не удалось связаться с вкладкой. Перезагрузите F5. ' + e.message });
      });
    return true;
  }

  // dashboard → background: проверить связь с native host
  if (msg.action === 'native_ping') {
    console.log('[nezar-bg] native_ping');
    pingNativeHost()
      .then(r => { console.log('[nezar-bg] native_ping response:', r); sendResponse(r); })
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  // dashboard → background → native host: выполнить команду
  if (msg.action === 'native_run') {
    console.log('[nezar-bg] native_run: cwd=' + msg.cwd + ' cmd=' + (msg.command || '').slice(0, 60));
    runNativeCommand(msg.command, msg.cwd, msg.timeout)
      .then(r => {
        console.log('[nezar-bg] native_run done: ok=' + r.ok + ' exitCode=' + r.exitCode + ' stdoutLen=' + (r.stdout || '').length);
        sendResponse(r);
      })
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  console.log('[nezar-bg] unhandled message:', msg.action);
});
