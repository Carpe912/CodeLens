/**
 * MCP server 冒烟测试
 *
 * 把 `dist/mcp/codelens-mcp.js` 当**真实 MCP 客户端**驱动一遍：
 * 走 stdio 的换行分隔 JSON-RPC，依次 `initialize` → `tools/list` → 每个 `tools/call`，
 * 并断言返回形状。这样测的是协议本身，不是内部函数。
 *
 * 为什么不直接调 handler：MCP 最常见的翻车方式是**协议层**的
 * （stdout 混进调试日志、id 不回填、通知被当成请求回复），
 * 单测 handler 一个都盖不到。
 *
 * 用法：
 *   CODELENS_API_URL=http://47.116.6.132/code-api npm run check:mcp
 *   npm run check:mcp -- --repo 33
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// 无论本脚本是被 tsx 直接从 src/ 跑，还是编译后在 dist/ 里跑，
// 被测目标都是**构建产物** —— 用 cwd（npm run 时即包根）定位最稳。
const serverPath = join(process.cwd(), 'dist', 'mcp', 'codelens-mcp.js');
if (!existsSync(serverPath)) {
  console.error(`找不到 ${serverPath}\n请先执行 npm run build`);
  process.exit(1);
}

const argv = process.argv.slice(2);
const repoArgIdx = argv.indexOf('--repo');
const repoId = repoArgIdx >= 0 ? Number(argv[repoArgIdx + 1]) : 33;

interface Rpc {
  jsonrpc: '2.0';
  id?: number | string | null;
  method?: string;
  result?: any;
  error?: { code: number; message: string };
}

const child = spawn(process.execPath, [serverPath], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env },
});

let stderrBuf = '';
child.stderr.on('data', (d: Buffer) => {
  stderrBuf += d.toString();
});

const pending = new Map<number, (msg: Rpc) => void>();
let rawStdout = '';
let nextId = 1;

child.stdout.on('data', (chunk: Buffer) => {
  rawStdout += chunk.toString();
  let idx: number;
  while ((idx = rawStdout.indexOf('\n')) >= 0) {
    const line = rawStdout.slice(0, idx);
    rawStdout = rawStdout.slice(idx + 1);
    if (!line.trim()) continue;
    let msg: Rpc;
    try {
      msg = JSON.parse(line) as Rpc;
    } catch {
      failures.push(`stdout 出现非 JSON 内容（协议被污染）：${line.slice(0, 200)}`);
      continue;
    }
    const key = Number(msg.id);
    const resolve = pending.get(key);
    if (resolve) {
      pending.delete(key);
      resolve(msg);
    } else {
      failures.push(`收到无法匹配的响应 id=${String(msg.id)}`);
    }
  }
});

const failures: string[] = [];

function send(method: string, params?: unknown): Promise<Rpc> {
  const id = nextId++;
  const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
  return new Promise<Rpc>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} 超时（60s）`));
    }, 60_000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    child.stdin.write(payload + '\n');
  });
}

/** 通知：没有 id，不期待回复 */
function notify(method: string, params?: unknown): void {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

function ok(cond: boolean, label: string, detail = ''): void {
  if (cond) {
    console.log(`  ✅ ${label}`);
  } else {
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`);
    failures.push(label);
  }
}

function textOf(msg: Rpc): string {
  const content = msg.result?.content;
  if (!Array.isArray(content) || content.length === 0) return '';
  return content.map((c: any) => String(c.text ?? '')).join('\n');
}

async function main(): Promise<void> {
  console.log(`MCP server: ${serverPath}`);
  console.log(`CODELENS_API_URL=${process.env.CODELENS_API_URL ?? '(默认 https://sunlingyue.cn/code-api)'}\n`);

  // 1) initialize
  console.log('[1] initialize');
  const init = await send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'check-mcp', version: '1.0.0' },
  });
  ok(!init.error, 'initialize 无错误', JSON.stringify(init.error));
  ok(init.result?.protocolVersion === '2024-11-05', '协议版本回填正确');
  ok(init.result?.serverInfo?.name === 'codelens', 'serverInfo.name = codelens');
  notify('notifications/initialized');

  // 2) tools/list
  console.log('\n[2] tools/list');
  const list = await send('tools/list');
  const toolNames: string[] = (list.result?.tools ?? []).map((t: any) => t.name);
  ok(toolNames.length > 0, `返回了 ${toolNames.length} 个工具`);
  for (const want of ['list_repos', 'list_url_patterns', 'ask_codelens']) {
    ok(toolNames.includes(want), `包含工具 ${want}`);
  }
  const schema = (list.result?.tools ?? []).find((t: any) => t.name === 'list_url_patterns');
  ok(schema?.inputSchema?.required?.includes('repoId'), 'list_url_patterns 声明 required=[repoId]');

  // 3) 调用 list_repos
  console.log('\n[3] tools/call list_repos');
  const repos = await send('tools/call', { name: 'list_repos', arguments: {} });
  const reposText = textOf(repos);
  ok(!repos.error && repos.result?.isError !== true, '调用成功', JSON.stringify(repos.error));
  ok(/共 \d+ 个仓库/.test(reposText), '输出包含仓库总数');
  ok(reposText.includes(`#${repoId}`), `输出包含目标仓库 #${repoId}`);

  // 4) 调用 list_url_patterns（核心：必须是全集，不是 top-K）
  console.log(`\n[4] tools/call list_url_patterns {repoId: ${repoId}}`);
  const urls = await send('tools/call', { name: 'list_url_patterns', arguments: { repoId } });
  const urlsText = textOf(urls);
  if (urls.error || urls.result?.isError === true) {
    // 路由未上线时这里是 404 —— 明确报出来，不要静默通过
    ok(false, 'list_url_patterns 调用成功', urlsText.slice(0, 300));
  } else {
    const m = /共 (\d+) 个接口/.exec(urlsText);
    ok(m !== null, '输出包含接口总数');
    const total = m ? Number(m[1]) : 0;
    ok(total > 0, `接口数 > 0（实际 ${total}）`);
    ok(urlsText.includes('条数即全集'), '明确标注「条数即全集」');
    // 断言完整性：正文里的数据行数应当等于声明的总数
    const dataLines = urlsText
      .split('\n')
      .filter((l) => /^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|\(未判定\))\s/.test(l));
    ok(
      dataLines.length === total,
      `清单完整：声明 ${total} 条，实际列出 ${dataLines.length} 条`,
      dataLines.length === total ? '' : '存在截断或漏列'
    );
    console.log(`\n----- list_url_patterns 输出前 12 行 -----`);
    console.log(urlsText.split('\n').slice(0, 12).join('\n'));
    console.log('----- 前 5 行数据 -----');
    console.log(dataLines.slice(0, 5).join('\n'));
    // method 已判定的行必须排在前面：未判定的那批是诊断线索（前端路由/构建产物），
    // 顶到清单开头会让人以为它们才是接口
    ok(
      !/^\(未判定\)\s/.test(dataLines[0] ?? ''),
      '首行是可判定 method 的接口（未判定的排在最后）',
      `实际首行：${(dataLines[0] ?? '').slice(0, 60)}`
    );

    // 5) method 过滤
    console.log('\n[5] tools/call list_url_patterns {method: "POST"}');
    const posts = await send('tools/call', {
      name: 'list_url_patterns',
      arguments: { repoId, method: 'POST' },
    });
    const postsText = textOf(posts);
    const pm = /共 (\d+) 个接口/.exec(postsText);
    ok(pm !== null && Number(pm[1]) > 0, `POST 过滤有结果（${pm ? pm[1] : 0} 条）`);
    ok(Number(pm?.[1] ?? 0) <= total, 'POST 条数 ≤ 全量条数（过滤真的生效了）');
  }

  // 6) 未知工具应当报错而不是静默
  console.log('\n[6] 未知工具');
  const unknown = await send('tools/call', { name: 'no_such_tool', arguments: {} });
  ok(unknown.error?.code === -32602, '未知工具返回 -32602');

  // 7) 未知方法
  console.log('\n[7] 未知方法');
  const bad = await send('no/such/method');
  ok(bad.error?.code === -32601, '未知方法返回 -32601');

  // 8) stdout 洁净性
  console.log('\n[8] 协议通道洁净性');
  ok(!/Output format|listening|started/i.test(rawStdout), 'stdout 无调试输出残留');
  ok(/started/.test(stderrBuf), '启动日志出现在 stderr');

  child.stdin.end();
  child.kill();

  console.log('\n' + '='.repeat(56));
  if (failures.length === 0) {
    console.log('✅ 全部通过');
    process.exit(0);
  } else {
    console.log(`❌ ${failures.length} 项失败：`);
    for (const f of failures) console.log(`   - ${f}`);
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  console.error('冒烟测试异常终止：', error instanceof Error ? error.message : error);
  child.kill();
  process.exit(1);
});
