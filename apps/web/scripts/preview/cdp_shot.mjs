/**
 * 通过 CDP 驱动无头 Chrome，在本地预览页里**真实发一次请求**并整页截图。
 * 用于 UI 改版后的「肉眼验证」—— 本机访问不了线上（TLS 被拦），这是唯一能亲眼看到渲染结果的路。
 *
 * 用法：
 *   node scripts/preview/cdp_shot.mjs [问题] [输出.png] [等待ms] [模式标签]
 * 例：
 *   node scripts/preview/cdp_shot.mjs "登录功能是怎么实现的" /tmp/ask.png 26000
 *   node scripts/preview/cdp_shot.mjs "订单详情偶尔拿不到数据" /tmp/rc.png 26000 "根因分析"
 *
 * 前置（三样都要在同一条命令里起，见 codelens-deploy skill 第 9 节）：
 *   1) SSH 隧道:  ssh -N -L 8787:127.0.0.1:8787 <server>
 *   2) 静态服务:  python3 scripts/preview/serve.py
 *   3) Chrome:    .../Google\ Chrome --headless=new --no-sandbox --remote-debugging-port=9222 about:blank
 */
import fs from 'node:fs';

const [, , question = '登录功能是怎么实现的', outfile = '/tmp/shot.png', waitMs = '25000', modeLabel = ''] = process.argv;
const PORT = 9222;
const PAGE = 'http://127.0.0.1:4173/code/repo/29';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const page = (await r.json()).find((t) => t.type === 'page');
      if (page) return page;
    } catch { /* chrome 还没起来，继续等 */ }
    await sleep(500);
  }
  throw new Error('9222 上没有 page target —— Chrome 没起来或 --remote-debugging-port 没生效');
}

const target = await getTarget();
const ws = new WebSocket(target.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((res, rej) => {
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
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1200, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: PAGE });
await sleep(4500);

// 可选：先点模式标签（问答 / 搜索 / 根因分析）
if (modeLabel) {
  await send('Runtime.evaluate', {
    expression: `(() => {
      const b = [...document.querySelectorAll('header button')]
        .find((x) => x.textContent.trim() === ${JSON.stringify(modeLabel)});
      if (!b) return 'no-mode-btn';
      b.click();
      return 'mode=' + b.textContent.trim();
    })()`,
    returnByValue: true,
  });
  await sleep(600);
}

// React 受控输入必须走**原生 value setter** + input 事件；直接赋值 i.value 不会更新 React state
await send('Runtime.evaluate', {
  expression: `(() => {
    const i = document.querySelector('input[type="text"]');
    if (!i) return 'no-input';
    const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    s.call(i, ${JSON.stringify(question)});
    i.dispatchEvent(new Event('input', { bubbles: true }));
    return 'filled';
  })()`,
  returnByValue: true,
});
await sleep(300);

await send('Runtime.evaluate', {
  expression: `(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '提交');
    if (!b) return 'no-submit';
    b.click();
    return 'submitted';
  })()`,
  returnByValue: true,
});

// /ask 要走 检索→rerank→LLM，再接着 /query-call-tree，所以要给足时间
await sleep(Number(waitMs));

const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
fs.writeFileSync(outfile, Buffer.from(shot.data, 'base64'));
console.log('WROTE', outfile, fs.statSync(outfile).size, 'bytes');
ws.close();
process.exit(0);
