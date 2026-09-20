/**
 * 错误信息格式化 — 让「失败」永远带着原因出现
 *
 * ============================================
 * 为什么需要这个文件
 * ============================================
 * 本项目的运维脚本普遍用 `console.error(error.message)` 输出失败原因。
 * 但 Node 在「一次操作尝试了多个地址且全部失败」时会抛 **AggregateError**，
 * 而 AggregateError 的 `message` 是**空字符串**，`String(e)` 也只是 "AggregateError"。
 *
 * 最典型的触发场景就是数据库连不上：
 *   pg 会同时尝试 ::1（IPv6）和 127.0.0.1（IPv4），两个都 ECONNREFUSED，
 *   于是抛出一个 message 为空的 AggregateError。
 *
 * 后果：服务器上 PG 没启动、端口写错、或安全组没放行时，迁移脚本会输出
 *
 *     Migration Failed!
 *     ========================================
 *
 *     （什么都没有）
 *
 * 运维只能靠猜。这正是本项目反复踩到的「静默失败」模式：
 * 错误发生了，但没有任何可行动的信息浮出水面。
 *
 * ⚠️ 不要用 `error instanceof AggregateError` 检测：
 *    全局 AggregateError 是 ES2021 的，而本仓库 tsconfig 的 lib 是 ES2020，
 *    直接引用会编译失败（TS2304）。因此这里按结构检测 `errors` 数组 ——
 *    跨 realm / 跨内置实现也更稳。
 *
 * ============================================
 * 用法
 * ============================================
 *   import { describeError } from '../utils/errors.js';
 *   console.error(describeError(error));
 */

/** 结构化的 AggregateError 视图（不依赖全局 AggregateError） */
interface AggregateErrorView {
  errors: unknown[];
}

function asAggregate(error: unknown): AggregateErrorView | null {
  if (typeof error !== 'object' || error === null) return null;
  const maybe = (error as { errors?: unknown }).errors;
  return Array.isArray(maybe) ? { errors: maybe } : null;
}

function errorName(error: Error): string {
  const code = (error as NodeJS.ErrnoException).code;
  return code ? `${error.name} [${code}]` : error.name;
}

/** 单行版：适合放进「N 个文件失败」这类逐项列表里 */
export function describeErrorBrief(error: unknown): string {
  if (error == null) return '(无错误对象)';

  if (error instanceof Error) {
    const name = errorName(error);
    // 注意：`error.message ?? x` 挡不住空字符串，所以必须显式判空
    if (error.message) return `${name}: ${error.message}`;

    const agg = asAggregate(error);
    if (agg && agg.errors.length > 0) {
      return `${name}: ${agg.errors.map(describeErrorBrief).join('; ')}`;
    }
    return `${name}: (message 为空)`;
  }

  if (typeof error === 'string') return error || '(空字符串)';

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function indent(text: string, prefix = '    '): string {
  return text
    .split('\n')
    .map((line) => prefix + line)
    .join('\n');
}

/**
 * 把任意抛出物渲染成一段永远非空的、可诊断的文本。
 *
 * 设计原则：**宁可冗余，不能为空**。运维脚本的失败输出如果为空，
 * 排障成本会直接转嫁给下一个人。
 */
export function describeError(error: unknown): string {
  if (error == null) return '(无错误对象，但操作失败)';

  if (error instanceof Error) {
    const lines: string[] = [errorName(error)];

    // message 可能为空 —— 此时给出明确说明，绝不留空行
    lines.push(error.message ? indent(error.message) : '    (该错误的 message 为空)');

    // AggregateError 的真正信息在 errors[] 里，必须展开
    const agg = asAggregate(error);
    if (agg && agg.errors.length > 0) {
      lines.push(`    底层错误（${agg.errors.length} 项）:`);
      for (const inner of agg.errors) {
        lines.push(indent(describeErrorBrief(inner), '      - '));
      }
    }

    // 连接类错误的常见排查提示
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ETIMEDOUT') {
      lines.push('    → 检查：数据库/Redis 是否已启动、host/port 是否正确、安全组是否放行。');
    } else if (code === '28P01' || code === '28000') {
      lines.push('    → 检查：DB_USER / DB_PASSWORD 是否正确（口令认证失败）。');
    } else if (code === '3D000') {
      lines.push('    → 检查：DB_NAME 指定的数据库是否存在（需先 CREATE DATABASE）。');
    }

    if (error.stack) {
      lines.push(indent(error.stack.split('\n').slice(1, 5).join('\n')));
    }
    return lines.join('\n');
  }

  if (typeof error === 'string') return error;

  try {
    return JSON.stringify(error, null, 2);
  } catch {
    return String(error);
  }
}
