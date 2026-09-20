/**
 * `/ask` 的会话 ID 管理
 *
 * ============================================
 * 为什么需要它
 * ============================================
 * 界面上早就有「继续提问」和「本次会话第 N 轮」了，但在此之前**后端是无状态的**：
 * 追问只是把新问题当成一个全新的、互不相关的请求发出去。
 * 于是用户问「那它呢」「再往下看一层」时，检索词就是字面上的「那它呢」——
 * 召回一堆无关代码，或者直接命中「未检索到证据」的护栏。
 *
 * 也就是说，「第 N 轮」此前只是一个前端计数器，不代表后端真的记得前几轮。
 * 本文件把会话 ID 落到浏览器侧并随请求带上，让后端能把前几轮读回来。
 *
 * ============================================
 * 为什么按 repoId 分开存
 * ============================================
 * 后端按 `(session_id, repo_id)` 定位历史。前端若共用一个 session id 跨仓库追问，
 * 后端仍会按 repo 过滤，行为是对的；但分仓存储更直观，也避免用户在 A 仓看完
 * 切到 B 仓时，界面上的「第 N 轮」计数带着 A 仓的轮数继续涨。
 *
 * ============================================
 * 为什么要有「新会话」
 * ============================================
 * 会话历史会被注入提示词。如果只增不减，用户换了话题之后，旧上下文仍会
 * 挤占提示词预算，甚至把不相干的旧问题当成「指代对象」——
 * 表现为「我问了新东西，它还在回答上一个话题」。
 * 所以必须给用户一个显式的清空入口（清空时轮数也要一起归零）。
 */

/** localStorage key 前缀 */
const PREFIX = 'codelens.askSession.';

/**
 * 生成一个会话 ID。
 *
 * 用 `crypto.randomUUID()`；极老的浏览器没有它，退回「时间戳 + 随机数」——
 * 这个 ID 只需在本机内唯一即可，不承担安全职责。
 */
function newSessionId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 读取（必要时创建）某仓库当前的会话 ID */
export function getAskSessionId(repoId: string | number): string {
  const key = PREFIX + String(repoId);
  try {
    const existing = localStorage.getItem(key);
    if (existing && existing.trim()) return existing;
    const created = newSessionId();
    localStorage.setItem(key, created);
    return created;
  } catch {
    // localStorage 不可用（隐私模式 / 禁用）时退化为「本次请求内有效」的临时 ID。
    // 不抛错：会话记忆是增强能力，不能因为它拿不到存储就让问答整体失败。
    return newSessionId();
  }
}

/** 清空某仓库的会话，返回一个新的会话 ID */
export function resetAskSession(repoId: string | number): string {
  const key = PREFIX + String(repoId);
  const created = newSessionId();
  try {
    localStorage.setItem(key, created);
  } catch {
    /* 见 getAskSessionId 的说明 */
  }
  return created;
}
