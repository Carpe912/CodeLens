/**
 * URL 查询判定探针（纯函数，不连库、不需要服务器）。
 *
 * 目的：证明 `looksLikeUrlQuery()` 相对历史实现
 *   `q.match(/^https?:\/\//) || q.match(/\/[a-z]+\/[a-z]+/i)`
 * 是**严格超集** —— 即「只会多认出，不会少认出」，
 * 所以修 `/post/123` 之类的漏判不会带来任何既有行为的回退。
 *
 * 用法：
 *   npx tsx src/scripts/probe-url-query-detect.ts
 * 退出码：0 = 通过（超集成立且预定用例正确），1 = 失败。
 */
import { looksLikeUrlQuery } from '../retrieval/query-intent-parser.js';

/** 历史实现，逐字照抄（勿改）。 */
function legacyLooksLikeUrlQuery(q: string): boolean {
  return Boolean(q.match(/^https?:\/\//) || q.match(/\/[a-z]+\/[a-z]+/i));
}

/** 应当被判为 URL 的查询。 */
const SHOULD_BE_URL = [
  'https://api.example.com/users/42',
  'http://x.cn/api/v1/users',
  '/api/users',
  '/api/users/42',
  '/api/orders/123',
  '/post/123',            // ← 历史实现漏判（末段是数字）
  '/users/42',            // ← 历史实现漏判
  '/orders/7',            // ← 历史实现漏判
  '/v2/items/9',
  'GET /api/users',       // 允许出现在句子中间
  '找一下 /api/orders/1',  // 同上
  '/api/products/category/123',
];

/** 不应当被判为 URL 的查询。 */
const SHOULD_NOT_BE_URL = [
  'getUserById',
  'getUserById 在哪调用',
  'x/y',                  // 只有一段路径
  '/users',               // 单段（保持现状：不判为 URL）
  '/',
  '',
  'api/users',            // 没有前导 /
];

/**
 * **既有的**宽判（历史实现同样返回 true），本次不改变。
 * 说明判定是「不锚定首尾」的 —— 为的是不破坏 `GET /api/users`、
 * `找一下 /api/orders/1` 这类句子里带路径的查询；代价是 `a/b/c` 也会被判为 URL。
 * 这是**改造前就有的行为**，不是本次引入的。
 */
const PRE_EXISTING_BROAD = ['a/b/c', 'foo/bar/baz'];

/** 本次修复要专门验证的用例（历史实现为 false、新实现为 true）。 */
const FIXED_CASES = ['/post/123', '/users/42', '/orders/7', '/v2/items/9'];

let failures = 0;

console.log('='.repeat(72));
console.log('URL 查询判定探针');
console.log('='.repeat(72));

console.log('\n[1] 应当判为 URL（新实现必须为 true）');
for (const q of SHOULD_BE_URL) {
  const ok = looksLikeUrlQuery(q);
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${JSON.stringify(q)}`);
}

console.log('\n[2] 不应当判为 URL（新实现必须为 false）');
for (const q of SHOULD_NOT_BE_URL) {
  const bad = looksLikeUrlQuery(q);
  if (bad) failures++;
  console.log(`  ${bad ? 'FAIL' : 'PASS'}  ${JSON.stringify(q)}`);
}

console.log('\n[2b] 既有的宽判：历史实现与本次实现都应为 true（本次不改这一行为）');
for (const q of PRE_EXISTING_BROAD) {
  const before = legacyLooksLikeUrlQuery(q);
  const after = looksLikeUrlQuery(q);
  const ok = before === true && after === true;
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${JSON.stringify(q)}  legacy=${before} -> new=${after}`);
}

console.log('\n[3] 严格超集：历史实现为 true 的，新实现必须也为 true');
const seen = new Set<string>([...SHOULD_BE_URL, ...SHOULD_NOT_BE_URL, ...PRE_EXISTING_BROAD]);
const regression: string[] = [];
for (const q of seen) {
  if (legacyLooksLikeUrlQuery(q) && !looksLikeUrlQuery(q)) regression.push(q);
}
// 再穷举一批组合，加强超集证明
for (const seg of ['a', 'ab', 'users', '123', 'v1', 'x-y', 'a_b', 'p.q']) {
  for (const seg2 of ['a', 'users', '42', 'v2']) {
    for (const prefix of ['/', 'GET /', '找一下 /']) {
      const q = `${prefix}${seg}/${seg2}`;
      if (legacyLooksLikeUrlQuery(q) && !looksLikeUrlQuery(q)) regression.push(q);
    }
  }
}
if (regression.length > 0) {
  failures += regression.length;
  console.log(`  FAIL  发现 ${regression.length} 处回退：`, regression.slice(0, 8));
} else {
  console.log('  PASS  未发现任何回退（新实现是历史实现的超集）');
}

console.log('\n[4] 本次修复的用例（历史应为 false，新应为 true）');
for (const q of FIXED_CASES) {
  const before = legacyLooksLikeUrlQuery(q);
  const after = looksLikeUrlQuery(q);
  const ok = before === false && after === true;
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${JSON.stringify(q)}  legacy=${before} -> new=${after}`);
}

console.log('\n' + '='.repeat(72));
console.log(failures === 0 ? '==== ALL PASS ====' : `==== FAIL (${failures}) ====`);
console.log('='.repeat(72));
process.exit(failures === 0 ? 0 : 1);
