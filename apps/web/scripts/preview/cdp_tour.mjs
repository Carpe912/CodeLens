/**
 * 一次 Chrome 会话里走完多个界面状态并截图（UI 改版的「肉眼验证」批量版）。
 *
 * 为什么要有它：cdp_shot.mjs 一次只拍一个状态，而隧道/静态服务/Chrome 每起一次都要 5s+，
 * 且三者必须在同一条命令里（后台进程会被回收，见 codelens-deploy skill §9.2）。这个脚本
 * 在同一个会话里 navigate → 点模式 → 填问题 → 提交 → 截图，把 6~8 个状态一趟拍完。
 *
 * 用法：
 *   node scripts/preview/cdp_tour.mjs [--out /tmp/ui] [--only repo-empty,ask]
 *
 * 前置（三样必须在同一条命令里起）：
 *   1) ssh -N -L 8787:127.0.0.1:8787 root@47.116.6.132
 *   2) python3 scripts/preview/serve.py
 *   3) Google Chrome --headless=new --no-sandbox --remote-debugging-port=9222
 */
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const OUT = arg('--out', '/tmp/ui');
const ONLY = arg('--only', '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const PORT = 9222;
const BASE = 'http://127.0.0.1:4173';

/**
 * 每个状态：
 *   url    相对路径
 *   mode   要点的模式标签（省略 = 不动）
 *   q      填入主输入框的问题（省略 = 不提交，只拍初始/空态）
 *   wait   导航后的等待 ms
 *   after  提交后的等待 ms（/ask 要等检索→rerank→LLM→调用树，25~30s）
 *   w/h    视口尺寸（默认 1440x1200）
 */
const STEPS = [
  { name: '01-home', url: '/code/', wait: 4000 },
  { name: '02-repo-empty', url: '/code/repo/29', wait: 4000 },
  { name: '03-ask', url: '/code/repo/29', mode: '问答', q: '登录功能是怎么实现的', after: 30000 },
  { name: '04-rootcause', url: '/code/repo/29', mode: '根因分析', q: '订单详情偶尔拿不到数据，可能是什么原因', after: 30000 },
  { name: '05-search', url: '/code/repo/29', mode: '搜索', q: '/api/users', after: 6000 },
  { name: '06-impact-symbol', url: '/code/repo/29', mode: '影响面', q: 'resourceWithId', after: 6000 },
  { name: '07-impact-file', url: '/code/repo/29', mode: '影响面', q: 'test-repo/web/src/comm/components/PageHeader.vue', after: 6000 },
  { name: '08-ask-mobile', url: '/code/repo/29', mode: '问答', q: '登录功能是怎么实现的', after: 30000, w: 414, h: 900 },
  // 09 覆盖「懒加载的调用图弹窗」：它现在是 React.lazy + Suspense，
  // 不点开就验证不到（只发 dist 不做这一步，很容易把白屏弹窗发上线）
  { name: '09-callgraph-modal', url: '/code/repo/29', mode: '搜索', q: 'getOrders', after: 8000, click: '调用图', afterClick: 12000 },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 轮询式等待。
 *
 * 为什么不用固定 sleep：水合 + 拉 /repos/:id/stats 走的是 ssh 隧道，冷启动时
 * 前几秒按钮根本还没渲染出来，固定 4s 会「偶尔拍到空页」——这正是上一版
 * cdp_tour 所有 mode 步骤都返回 no-mode、截出 7.7KB 纯白图的原因。
 * 现在改成「每 400ms 探一次，探到就走」，超时才报错并 dump 真实按钮文案。
 */
let jsEval = null; // 赋值见下方 `jsEval = js`
async function waitFor(expr, timeout = 25000, interval = 400) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    last = await jsEval(expr);
    if (last && last !== false) return last;
    await sleep(interval);
  }
  return false;
}

async function getTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const page = (await r.json()).find((t) => t.type === 'page');
      if (page) return page;
    } catch {
      /* chrome 还没起来 */
    }
    await sleep(500);
  }
  throw new Error('9222 上没有 page target —— Chrome 没起来');
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

const js = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return r?.result?.value;
};
jsEval = js;

/** 当前页面所有可见按钮的文案 —— 定位按钮失败时用来 dump 真相 */
const BTN_TEXTS = `[...document.querySelectorAll('button')].map(b=>b.textContent.trim()).filter(Boolean)`;

const shot = async (file, fullPage) => {
  const r = await send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: !!fullPage,
  });
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  return fs.statSync(file).size;
};

fs.mkdirSync(OUT, { recursive: true });
const report = [];

for (const s of STEPS) {
  if (ONLY.length && !ONLY.includes(s.name)) continue;
  const w = s.w ?? 1440;
  const h = s.h ?? 1200;
  await send('Emulation.setDeviceMetricsOverride', {
    width: w,
    height: h,
    deviceScaleFactor: 1,
    mobile: !!(s.w && s.w < 600),
  });
  await send('Page.navigate', { url: 'about:blank' });
  await sleep(250);
  await send('Page.navigate', { url: BASE + s.url });

  const notes = [];

  // 先等页面「有内容」：命令条上的任一模式按钮出现，说明水合与取数都完成了。
  // 首页（/code/）没有模式条，改等 body 有文字。这样两种页面都能自适应。
  const ready = await waitFor(
    s.mode
      ? `(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===${JSON.stringify(s.mode)}); return b ? 'ready' : false; })()`
      : `(() => document.body.innerText.trim().length > 60 ? 'ready' : false)()`,
    s.wait ? Math.max(s.wait, 25000) : 25000
  );
  if (!ready) {
    const btns = await js(BTN_TEXTS);
    notes.push(`NOT-READY(btns=${JSON.stringify(btns)})`);
    const f = path.join(OUT, `${s.name}.png`);
    const sz = await shot(f, false);
    report.push(`${s.name}  ${w}x${h}  ${sz}B  ${notes.join(' ')}`);
    continue;
  }

  if (s.mode) {
    const r = await js(`(() => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(s.mode)});
      if (!b) return 'no-mode:' + ${JSON.stringify(s.mode)};
      b.click();
      return 'mode=' + b.textContent.trim();
    })()`);
    notes.push(r);
    if (String(r).startsWith('no-mode')) {
      const btns = await js(BTN_TEXTS);
      notes.push(`btns=${JSON.stringify(btns)}`);
      const f = path.join(OUT, `${s.name}.png`);
      const sz = await shot(f, false);
      report.push(`${s.name}  ${w}x${h}  ${sz}B  ${notes.join(' ')}`);
      continue;
    }
    await sleep(700);
  }
  if (s.q) {
    const filled = await waitFor(
      `(() => {
        const i = document.querySelector('input[type="text"], textarea');
        if (!i) return false;
        const proto = i.tagName === 'TEXTAREA' ? HTMLTextAreaElement : HTMLInputElement;
        const set = Object.getOwnPropertyDescriptor(proto.prototype, 'value').set;
        set.call(i, ${JSON.stringify(s.q)});
        i.dispatchEvent(new Event('input', { bubbles: true }));
        return 'filled';
      })()`,
      8000
    );
    notes.push(filled || 'no-input');
    await sleep(400);
    if (s.auto) {
      // 搜索模式在 onChange 里有 800ms 防抖自动提交，再点一次会重复发请求
      notes.push('auto-submit(debounced)');
    } else {
      notes.push(
        await js(`(() => {
          const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '提交');
          if (!b) return 'no-submit';
          b.click();
          return 'submitted';
        })()`)
      );
    }
    await sleep(s.after ?? 6000);
  }

  // 可选：再点一个按钮（用来覆盖「弹窗/懒加载组件」这类只有交互后才出现的状态）
  if (s.click) {
    const r = await js(`(() => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(s.click)});
      if (!b) return 'no-btn:' + ${JSON.stringify(s.click)};
      b.click();
      return 'clicked=' + b.textContent.trim();
    })()`);
    notes.push(r);
    await sleep(s.afterClick ?? 6000);
  }

  const viewport = path.join(OUT, `${s.name}.png`);
  const full = path.join(OUT, `${s.name}-full.png`);
  const s1 = await shot(viewport, false);
  const s2 = await shot(full, true);
  report.push(`${s.name}  ${w}x${h}  viewport=${s1}B full=${s2}B  ${notes.join(' ')}`);
}

console.log(report.join('\n'));
ws.close();
process.exit(0);
