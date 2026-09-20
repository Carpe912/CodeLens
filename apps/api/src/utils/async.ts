/**
 * 异步调用的超时与重试（单一事实来源）
 *
 * ============================================
 * 为什么必须集中一份
 * ============================================
 * `withTimeout` 原本是 `agent/core.ts` 里的一个模块私有函数，
 * 只给检索调用套了超时；而**真正会挂住整个 HTTP 请求的是 LLM 调用**，
 * 它当时没有任何超时 —— 上游模型不返回，`/ask` 就一直挂着，
 * 表现为「页面转圈，服务端日志干净」，非常难排查。
 *
 * 两处各写一份超时实现必然会漂移（阈值、错误文案、清理时序），
 * 所以集中到这里，由调用方传自己的超时值。
 *
 * ============================================
 * 语义约定
 * ============================================
 * - `withTimeout` 超时后**只以错误拒绝**，不尝试取消底层 promise
 *   （JS 里无法真正取消一个已发出的 fetch/查询）。底层 promise 仍会跑完，
 *   只是它的结果被丢弃。因此**不要**把它当作资源回收手段。
 * - 超时后必须 `clearTimeout`，否则定时器会拖住事件循环，
 *   在 tsx watch / 短生命周期脚本里会造成「进程不退出」。
 * - `withRetry` 只重试**失败**的调用，不做抖动退避以外的复杂策略；
 *   重试次数按「总尝试次数」计（attempts=3 → 最多调用 3 次）。
 */

/** 超时错误：带上 label，方便在日志里区分是哪一步超时 */
export class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`[timeout] ${label} 超过 ${ms}ms 未返回`);
    this.name = 'TimeoutError';
  }
}

/**
 * 给 Promise 套一层超时，超时后以 `TimeoutError` 拒绝。
 *
 * @param promise 被包裹的异步调用
 * @param ms      超时毫秒数；<= 0 视为「不超时」，直接返回原 promise
 * @param label   出现在错误信息里的步骤名
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  // 允许显式关闭超时：配置里写 0 通常意味着「不要限制」
  if (!ms || ms <= 0) return promise;

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

export interface RetryOptions {
  /** 总尝试次数（含首次）。<= 1 表示不重试 */
  attempts?: number;
  /** 每次尝试之间的等待毫秒数（线性，不指数退避） */
  delayMs?: number;
  /** 每次尝试的超时毫秒数；<= 0 表示不限制 */
  timeoutMs?: number;
  /** 步骤名，用于错误信息与日志 */
  label?: string;
  /**
   * 判断某个错误是否值得重试。默认：一律重试。
   * 传入它可以把「参数错误」这类必然失败的情况挡在重试之外。
   */
  shouldRetry?: (error: unknown) => boolean;
  /** 每次尝试失败后的回调（第几次、错误），用于外部记日志 */
  onAttemptFailed?: (attempt: number, error: unknown) => void;
}

/**
 * 带超时的重试包装。
 *
 * @returns 首次成功的结果
 * @throws  最后一次失败的错误（保留原始错误，不包装成汇总错误，
 *          否则真正的失败原因会被埋在 AggregateError 里）
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    attempts = 2,
    delayMs = 0,
    timeoutMs = 0,
    label = 'operation',
    shouldRetry,
    onAttemptFailed,
  } = options;

  const total = Math.max(1, Math.floor(attempts));
  let lastError: unknown;

  for (let attempt = 1; attempt <= total; attempt++) {
    try {
      return await withTimeout(fn(), timeoutMs, label);
    } catch (error) {
      lastError = error;

      const canRetry = attempt < total && (!shouldRetry || shouldRetry(error));
      onAttemptFailed?.(attempt, error);
      if (!canRetry) break;

      if (delayMs > 0) await sleep(delayMs);
    }
  }

  throw lastError;
}

/** 等待指定毫秒 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
