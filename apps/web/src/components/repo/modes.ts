/**
 * 四档模式的定义与视觉语言（从 RepoPage 抽出，供命令条 / 空态 / 徽章共用）。
 *
 * `impact`（影响面）是后加的第四档：它和前三档**不是同一种输入**——
 * 前三档收自然语言提问，它收一个符号名或文件路径。共用同一个输入框是刻意的，
 * 因为「输入一个名字 → 得到结构化结果」的交互是一致的，差别在结果怎么渲染。
 */
export type Mode = 'ask' | 'search' | 'root-cause' | 'impact';

export const MODES: Array<{ id: Mode; label: string; hint: string; placeholder: string }> = [
  {
    id: 'ask',
    label: '问答',
    hint: '用自然语言提问 → 生成带证据出处的回答',
    placeholder: '例如：登录功能是怎么实现的',
  },
  {
    id: 'search',
    label: '搜索',
    hint: '关键词或接口路径 → 精确到文件与行',
    placeholder: '例如：/api/users 或 getOrders',
  },
  {
    id: 'root-cause',
    label: '根因分析',
    hint: '描述异常现象 → 推断可能的原因链',
    placeholder: '例如：订单详情偶尔拿不到数据，可能是什么原因',
  },
  {
    id: 'impact',
    label: '影响面',
    hint: '改动某个符号或文件 → 列出会被波及的所有位置',
    placeholder: '例如：getOrders 或 test-repo/src/utils/apiFactory.js',
  },
];

/** 空态下的示例问题：让「这个页面能干什么」不言自明 */
export const EXAMPLE_QUESTIONS: Record<Mode, string[]> = {
  ask: ['登录功能是怎么实现的', '订单列表是怎么获取的', 'API 路径是怎么拼装出来的'],
  search: ['/api/users', 'getOrders', 'batchProcessOrders'],
  'root-cause': ['订单详情偶尔拿不到数据，可能是什么原因'],
  impact: ['resourceWithId', 'getOrders', 'test-repo/src/utils/apiFactory.js'],
};

export const MODE_BADGE: Record<Mode, { label: string; className: string }> = {
  ask: { label: '问答', className: 'bg-blue-100 border-blue-200 text-blue-700' },
  search: { label: '搜索', className: 'bg-cyan-100 border-cyan-200 text-cyan-700' },
  'root-cause': { label: '根因分析', className: 'bg-rose-100 border-rose-200 text-rose-700' },
  impact: { label: '影响面', className: 'bg-violet-100 border-violet-200 text-violet-700' },
};
