/**
 * 接口清单面板的端到端验收（CDP 驱动无头 Chrome）。
 *
 * 为什么不能只靠 curl：curl 只能证明「bundle 里有这串文案」，
 * 证明不了**表格真的渲染出来了、筛选项真的过滤对了**。
 * 本机访问不了线上（TLS 被拦），所以走本地预览产物 + 公网 API。
 *
 * 前置（同一条命令里起，见 codelens-deploy skill 第 9 节）：
 *   1) 静态服务  python3 scripts/preview/serve.py --root dist-preview
 *   2) Chrome    --headless=new --remote-debugging-port=9222
 * 预览产物需 `VITE_API_BASE_URL=http://47.116.6.132/code-api vite build --outDir dist-preview`。
 *
 * 用法：node scripts/preview/cdp_inventory.mjs [repoId] [出图目录]
 */
import fs from 'node:fs';

const [, , repoId = '33', outDir = '/tmp'] = process.argv;
const PORT = 9222;
const BASE = 'http://127.0.0.1:4173';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const page = (await r.json()).find((t) => t.type === 'page');
      if (page) return page;
    } catch {
      /* Chrome 还没起来 */
    }
    await sleep(500);
  }
  throw new Error('9222 上没有 page target —— Chrome 没起来或 --remote-debugging-port 没生效');
}

const target = await getTarget();
const ws = new WebSocket(target.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
  }
};
await new Promise((r, j) => {
  ws.onopen = r;
  ws.onerror = j;
});

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', {
  width: 1440,
  height: 1400,
  deviceScaleFactor: 1,
  mobile: false,
});

/** 收集控制台错误 —— 渲染报错不会让断言失败，但会让页面静默缺一块 */
const consoleErrors = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    consoleErrors.push((m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
  }
});

const evalIn = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(`页面内异常: ${JSON.stringify(r.exceptionDetails)}`);
  return r.result.value;
};

const shot = async (name) => {
  const s = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  const p = `${outDir}/${name}`;
  fs.writeFileSync(p, Buffer.from(s.data, 'base64'));
  console.log(`   📷 ${p} (${fs.statSync(p).size} bytes)`);
};

let failed = 0;
const check = (name, pass, detail = '') => {
  if (!pass) failed++;
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};

// ───────────────────────── 1. 打开仓库页并点开面板 ─────────────────────────
console.log(`\n▶ 打开 ${BASE}/code/repo/${repoId}`);
await send('Page.navigate', { url: `${BASE}/code/repo/${repoId}` });
await sleep(5000);

const opened = await evalIn(`(() => {
  const b = [...document.querySelectorAll('header button')]
    .find((x) => x.textContent.includes('接口'));
  if (!b) return 'no-pill';
  b.click();
  return 'clicked: ' + b.textContent.trim();
})()`);
check('顶栏「接口 N」是一个可点开的入口', opened.startsWith('clicked'), opened);

// ⚠️ 这个数必须是可调用接口数（254），不能是 url_patterns 裸行数（283）——
//    否则顶栏和点开后的面板会给出两个互相矛盾的「接口数」。
const pillNum = Number((opened.match(/接口(\d+)/) || [])[1]);
check('顶栏接口数 = 254（可调用口径，不是 283 原始行数）', pillNum === 254, `实际 ${pillNum}`);

// 等面板真的渲染出来（要打公网 API，给足时间）
let ready = false;
for (let i = 0; i < 30; i++) {
  const has = await evalIn(`!!document.querySelector('[data-testid="inv-scope"]')`);
  if (has) {
    ready = true;
    break;
  }
  await sleep(1000);
}
check('清单面板渲染出「计数口径」行', ready);
if (!ready) {
  await shot('inv-fail.png');
  console.log('\n❌ 面板没出现，提前退出');
  process.exit(1);
}

// ───────────────────────── 2. 口径数字 ─────────────────────────
const scope = await evalIn(
  `document.querySelector('[data-testid="inv-scope"]').innerText.replace(/\\s+/g, ' ').trim()`
);
console.log(`   scope = ${scope}`);
check('口径行含原始行 283', /原始行\s*283/.test(scope), scope);
check('口径行含去重 277', /合并\s*277/.test(scope), scope);
check('口径行含已判定 238', /238\s*个已判定/.test(scope), scope);
check('口径行含未判定接口 16', /16\s*个是接口但未判定/.test(scope), scope);

const groups = await evalIn(
  `[...document.querySelectorAll('[data-testid="inv-group"]')].map(s => s.getAttribute('data-group'))`
);
console.log(`   分组(${groups.length}): ${groups.slice(0, 6).join(', ')} …`);

const rowCount = await evalIn(`document.querySelectorAll('[data-testid="inv-row"]').length`);
check('主表渲染 238 行（= 已判定接口数，不是 277）', rowCount === 238, `实际 ${rowCount}`);
check('分组数 > 1（确实按前缀分了组）', groups.length > 1, `实际 ${groups.length}`);

// 抽样核对：表格里的路径应能在 API 返回里找到
const samplePaths = await evalIn(
  `[...document.querySelectorAll('[data-testid="inv-row"]')].slice(0, 5).map(r => r.getAttribute('data-path'))`
);
console.log(`   抽样路径: ${samplePaths.join(' | ')}`);
check('路径非空且形如 /xxx', samplePaths.every((p) => p && p.startsWith('/')), samplePaths[0]);

await shot('inv-01-all.png');

// ───────────────────────── 3. method 筛选 ─────────────────────────
const postClicked = await evalIn(`(() => {
  const b = document.querySelector('[data-testid="inv-chip"][data-method="POST"]');
  if (!b) return 'no-chip';
  b.click();
  return b.textContent.trim();
})()`);
await sleep(500);
const postRows = await evalIn(`document.querySelectorAll('[data-testid="inv-row"]').length`);
const postMismatch = await evalIn(
  `[...document.querySelectorAll('[data-testid="inv-row"]')].filter(r => r.getAttribute('data-method') !== 'POST').length`
);
check('点 POST 筛选后行数 = 124（与后端 byMethod 一致）', postRows === 124, `实际 ${postRows}`);
check('筛选后没有非 POST 的行漏进来', postMismatch === 0, `越界 ${postMismatch} 行`);
await shot('inv-02-post.png');

// 回到全部
await evalIn(`document.querySelector('[data-testid="inv-chip-all"]').click()`);
await sleep(400);

// ───────────────────────── 4. 关键词搜索 ─────────────────────────
await evalIn(`(() => {
  const i = document.querySelector('[data-testid="inv-search"]');
  const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  s.call(i, 'scenario');
  i.dispatchEvent(new Event('input', { bubbles: true }));
  return 'ok';
})()`);
await sleep(600);
const searchRows = await evalIn(`document.querySelectorAll('[data-testid="inv-row"]').length`);
const searchBad = await evalIn(
  `[...document.querySelectorAll('[data-testid="inv-row"]')]
     .filter(r => !r.getAttribute('data-key').includes('scenario')).length`
);
check('搜索 scenario 有命中且都被过滤正确', searchRows > 0 && searchBad === 0,
  `命中 ${searchRows} 行，越界 ${searchBad} 行`);
// 注意：搜索的命中面是「路径 / 原始写法 / 定义文件」三者，不是只有路径 ——
// 所以像 TestScenarioData/index.ts 这种**靠文件名命中**的行也会出现，这是设计行为。
const viaFileOnly = await evalIn(
  `[...document.querySelectorAll('[data-testid="inv-row"]')]
     .filter(r => !r.getAttribute('data-path').includes('scenario')
                  && r.getAttribute('data-key').includes('scenario')).length`
);
check('命中面包含「靠原始写法/定义文件命中的行」', viaFileOnly > 0, `${viaFileOnly} 行非路径命中`);
await shot('inv-03-search.png');

// 清空搜索
await evalIn(`(() => {
  const i = document.querySelector('[data-testid="inv-search"]');
  const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  s.call(i, '');
  i.dispatchEvent(new Event('input', { bubbles: true }));
})()`);
await sleep(400);

// ───────────────────────── 5. method 未判定 三分类 ─────────────────────────
await evalIn(`document.querySelector('[data-testid="inv-pending-toggle"]').click()`);
await sleep(600);
const buckets = await evalIn(`(() => {
  const out = {};
  document.querySelectorAll('[data-testid="inv-pending-bucket"]').forEach(b => {
    out[b.getAttribute('data-kind')] = b.querySelectorAll('tbody tr').length;
  });
  return out;
})()`);
console.log(`   未判定分桶: ${JSON.stringify(buckets)}`);
check('未判定区把「真接口」与「非接口」分开列（16 / 23）',
  buckets.interface === 16 && buckets['not-interface'] === 23, JSON.stringify(buckets));
await shot('inv-04-pending.png');

// ───────────────────────── 6. 控制台无报错 ─────────────────────────
const realErrors = consoleErrors.filter((e) => !/favicon|Download the React DevTools/i.test(e));
check('页面控制台无错误', realErrors.length === 0, realErrors.slice(0, 2).join(' / '));

console.log('\n' + '='.repeat(56));
if (failed === 0) {
  console.log('✅ 接口清单面板端到端验收全部通过');
} else {
  console.log(`❌ ${failed} 项失败`);
}
ws.close();
process.exit(failed === 0 ? 0 : 1);
