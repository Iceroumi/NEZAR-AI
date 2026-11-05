/*
 * Локальный тест native host без браузера.
 * Эмулирует сообщение от Chrome (4-байта длина + JSON) и читает ответ.
 *
 * ВАЖНО: НЕ закрываем stdin сразу — Chrome держит port открытым.
 * Закрываем только после получения ответа (или таймаут).
 */

const { spawn } = require('child_process');
const path = require('path');

const HOST = path.join(__dirname, 'host.js');

function encode(msg) {
  const json = Buffer.from(JSON.stringify(msg), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  return Buffer.concat([header, json]);
}

function decode(buf) {
  const results = [];
  let pos = 0;
  while (pos + 4 <= buf.length) {
    const len = buf.readUInt32LE(pos);
    if (pos + 4 + len > buf.length) break;
    const raw = buf.slice(pos + 4, pos + 4 + len).toString('utf8');
    try { results.push(JSON.parse(raw)); } catch (e) { results.push({ parse_error: e.message, raw }); }
    pos += 4 + len;
  }
  return results;
}

async function runTest(name, message, timeoutMs = 15000) {
  return new Promise((resolve) => {
    console.log('\n=== TEST: ' + name + ' ===');
    console.log('SEND: ' + JSON.stringify(message).slice(0, 200));

    const child = spawn(process.execPath, [HOST], { stdio: ['pipe', 'pipe', 'pipe'] });
    const stdoutBuf = [];
    let stderrText = '';
    const messages = [];
    let done = false;

    const finish = (reason) => {
      if (done) return;
      done = true;
      clearTimeout(killTimer);
      try { child.stdin.end(); } catch (e) {}
      try { child.kill('SIGTERM'); } catch (e) {}
      console.log('RECV ' + messages.length + ' messages (' + reason + '):');
      messages.forEach((m, i) => console.log('  [' + i + ']', JSON.stringify(m).slice(0, 400)));
      if (stderrText) console.log('STDERR: ' + stderrText.trim().split('\n').slice(-3).join(' | '));
      resolve(messages);
    };

    // Парсим stdout по мере поступления
    child.stdout.on('data', (d) => {
      stdoutBuf.push(d);
      const combined = Buffer.concat(stdoutBuf);
      const decoded = decode(combined);
      // Декодируем заново, чтобы получить все сообщения (могут приходить частями)
      // Простой подход: копим и декодируем при каждом чихе
      for (const m of decoded) {
        // Проверяем, не дубликат ли (по id+type+text-фрагменту)
        const exists = messages.some(existing =>
          JSON.stringify(existing) === JSON.stringify(m)
        );
        if (!exists) messages.push(m);
      }
      // Если получили done/error — закрываем
      if (decoded.some(m => m.type === 'done' || m.type === 'error' || m.type === 'pong')) {
        finish('response received');
      }
    });

    child.stderr.on('data', (d) => { stderrText += d.toString('utf8'); });
    child.on('close', () => { finish('process closed'); });

    try {
      child.stdin.write(encode(message));
    } catch (e) {
      console.error('write failed:', e.message);
      finish('write error');
    }

    const killTimer = setTimeout(() => finish('timeout'), timeoutMs);
  });
}

(async () => {
  let passCount = 0, failCount = 0;

  // Test 1: ping
  const t1 = await runTest('ping', { id: 't1', type: 'ping' });
  if (t1.some(m => m.type === 'pong')) { console.log('PASS'); passCount++; }
  else { console.log('FAIL'); failCount++; }

  // Test 2: простая команда echo
  const t2 = await runTest('echo hello', { id: 't2', command: 'echo hello from native host' });
  if (t2.some(m => m.type === 'done' && (m.stdout || '').includes('hello from native host'))) { console.log('PASS'); passCount++; }
  else { console.log('FAIL'); failCount++; }

  // Test 3: команда с cwd
  const t3 = await runTest('ls (cwd test)', { id: 't3', command: 'ls -la', cwd: __dirname, timeout: 8000 });
  if (t3.some(m => m.type === 'done' && (m.stdout || '').includes('host.js'))) { console.log('PASS'); passCount++; }
  else { console.log('FAIL'); failCount++; }

  // Test 4: команда с ошибкой (несуществующая команда)
  const t4 = await runTest('nonexistent command', { id: 't4', command: 'this_command_does_not_exist_xyz', timeout: 8000 });
  // Должен вернуть done с exitCode !== 0 (в shell-mode) или error
  if (t4.some(m => m.type === 'done' && m.exitCode !== 0) || t4.some(m => m.type === 'error')) { console.log('PASS'); passCount++; }
  else { console.log('FAIL'); failCount++; }

  // Test 5: короткий sleep
  const t5 = await runTest('sleep 1', { id: 't5', command: 'sleep 1 && echo done', timeout: 8000 });
  if (t5.some(m => m.type === 'done' && (m.stdout || '').includes('done'))) { console.log('PASS'); passCount++; }
  else { console.log('FAIL'); failCount++; }

  console.log('\n=== Results: ' + passCount + ' passed, ' + failCount + ' failed ===');
  process.exit(failCount === 0 ? 0 : 1);
})();
