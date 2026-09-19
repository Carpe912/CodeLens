#!/usr/bin/env bash
#
# CodeLens 增量索引「端到端」验证用的极小 Git 仓库生成器。
#
#   make-e2e-git-fixture.sh make    <origin.git>   # 造出提交 1–5（停在 commit 5）
#   make-e2e-git-fixture.sh advance <origin.git>   # 再追加提交 6–7（上游前进）
#
# ── 为什么要这么分两步 ────────────────────────────────────────────────────
# 端到端要验证的是「索引停在旧状态 X，上游前进到 Y，应用后索引从 X 增量到 Y」。
# 所以必须：**先让 CodeLens 全量索引 commit 5 的状态，再把 origin 推进到 commit 7**。
# 反过来做（先索引 tip 再回退工作区）测不出东西 —— 内容哈希一致，
# indexMultipleFiles 会正确地判定「无变更」并返回 null，报告里只会留一句
# 「上游有变更，但文件内容与索引一致，未触发重建」。
# 本脚本的 make/advance 分工就是为了避免这个陷阱。
#
# ── 为什么不用 testwire-frontend（1623 文件 / 1532 可索引）直接测 ────────────
# 线上向量是开着的（DashScope qwen3.7-text-embedding，1536 维），
# 首次全量索引 1532 个文件 ≈ 3.5 万次 embedding 调用，对一次「链路是否通」的
# 验证来说代价过大。而要走通的代码路径与该规模无关：
#   POST /repos/from-gitlab → cloneGitLabRepo → indexRepository（全量）
#   → POST /repos/:id/upstream-check → getUpstreamStatus
#   → POST /repos/:id/refresh → refreshGitLabRepo → fastForwardToUpstream
#   → collectCandidatePaths → indexMultipleFiles → saveIncrementalReport
# 本脚本造出的 origin 走的是**完全同一条路径**，只是规模降到 8 个文件。
#
# ── advance 刻意构造的变更（提交 6–7）─────────────────────────────────────
#   提交6  A src/services/discount.ts               （新文件 → 新增实体）
#         M src/services/purchase.ts              （新增 applyDiscount，且新增 import）
#         M src/api/routes.ts                     （新增 GET /api/discounts → 新函数 + 新 url_pattern）
#   提交7  R src/services/user.ts → account.ts     （纯改名 → 差集里是 removed + added，
#                                                    注意 moved ≠ 改名，见下）
#         M src/services/order-service.ts         （常量 ORDER_PREFIX → ORDER_ID_PREFIX）
#         M src/index.ts                          （跟随改名的 import 更新）
#         D src/legacy/old-helper.ts              （删除文件 → 删除实体）
#
# ⚠️ `moved` 的语义：`diffEntitySnapshots` 的 moved = **同一 (kind, path, symbol) 的行号变了**，
#    也就是「符号在同一个文件里位移」。**文件改名不算 moved**，改名必然是
#    to=account.ts「新增」+ from=user.ts「删除」。所以想看 moved，得看 routes.ts /
#    index.ts 这类「插了一行导致后面全线下移」的文件。
#
set -euo pipefail

usage() { echo "用法: make-e2e-git-fixture.sh make|advance <origin.git 路径>"; }

# 注意：不要把 {make|advance} 写进 ${1:?...} 的提示串里 ——
# 那个 `}` 会提前闭合参数展开，MODE 会变成提示文字本身（极难看出来）。
MODE="${1:-}"
DEST="${2:-}"
if [ -z "$MODE" ] || [ -z "$DEST" ]; then usage; exit 1; fi

WORK="$(mktemp -d)"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

git_init_commit() {  # 在 $SEED 里初始化并提交
  git init -q -b master
  git config user.email "fixture@codelens.local"
  git config user.name  "CodeLens Fixture"
  git config commit.gpgsign false
}

write_common_initial() {
  mkdir -p src/api src/services src/utils src/legacy

  cat > package.json <<'EOF'
{
  "name": "e2e-fixture",
  "version": "1.0.0",
  "private": true,
  "description": "CodeLens 增量索引端到端验证用极小工程"
}
EOF

  cat > tsconfig.json <<'EOF'
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "strict": true,
    "skipLibCheck": true
  }
}
EOF

  cat > README.md <<'EOF'
# e2e-fixture

用于 CodeLens 增量索引端到端验证的极小工程。
EOF

  cat > src/services/order.ts <<'EOF'
export interface Order {
  id: string;
  amount: number;
}

export const ORDER_PREFIX = 'ord-';

export function createOrder(input: { amount: number }): Order {
  return { id: ORDER_PREFIX + Date.now(), amount: input.amount };
}

export function cancelOrder(id: string): boolean {
  return id.startsWith(ORDER_PREFIX);
}
EOF

  cat > src/services/user.ts <<'EOF'
export interface User {
  id: string;
  name: string;
}

export function createUser(name: string): User {
  return { id: 'usr-' + name, name };
}
EOF

  cat > src/utils/format.ts <<'EOF'
export function fmtMoney(cents: number): string {
  return (cents / 100).toFixed(2);
}

export function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
EOF

  cat > src/legacy/old-helper.ts <<'EOF'
export const LEGACY_FLAG = 'legacy-on';

export function legacyCalc(a: number, b: number): number {
  return a + b;
}
EOF

  cat > src/api/routes.ts <<'EOF'
import express from 'express';
import { createOrder, cancelOrder } from '../services/order';

const router = express.Router();

router.post('/api/orders', async (req, res) => {
  const order = createOrder(req.body);
  res.status(201).json(order);
});

router.delete('/api/orders/:id', async (req, res) => {
  const ok = cancelOrder(req.params.id);
  res.status(ok ? 204 : 404).send();
});

export default router;
EOF

  cat > src/index.ts <<'EOF'
import { createOrder, cancelOrder } from './services/order';
import { createUser } from './services/user';
import { fmtMoney, fmtDate } from './utils/format';

export function bootstrap() {
  const order = createOrder({ amount: 1299 });
  const user = createUser('demo');
  console.log(fmtMoney(order.amount), fmtDate(new Date()), user.id);
  return { order, user };
}

export { cancelOrder };
EOF
}

# ═══════════════════════════════ make ═══════════════════════════════
if [ "$MODE" = "make" ]; then
  SEED="$WORK/seed"
  mkdir -p "$SEED"
  cd "$SEED"
  git_init_commit
  write_common_initial

  git add -A
  git commit -q -m "init: 工程骨架（订单/用户服务、工具函数、路由）"

  # ── 提交 2：用户服务补一个函数 ──
  cat > src/services/user.ts <<'EOF'
export interface User {
  id: string;
  name: string;
}

export function createUser(name: string): User {
  return { id: 'usr-' + name, name };
}

export function findUserById(id: string): User | null {
  if (!id) {
    return null;
  }
  return { id, name: 'unknown' };
}
EOF
  git add -A
  git commit -q -m "feat: 用户服务补充按 id 查询"

  # ── 提交 3：只改非代码文件（验证纯文档提交不炸链路）──
  cat > README.md <<'EOF'
# e2e-fixture

用于 CodeLens 增量索引端到端验证的极小工程。

## 模块

- `src/api/routes.ts` —— express 路由
- `src/services/` —— 领域服务
- `src/utils/format.ts` —— 格式化工具
EOF
  git add -A
  git commit -q -m "chore: 补 README 模块说明"

  # ── 提交 4：新增采购服务（A / M）──
  cat > src/services/purchase.ts <<'EOF'
export interface Purchase {
  id: string;
  amount: number;
}

export const PURCHASE_PREFIX = 'pur-';

export function createPurchase(amount: number): Purchase {
  return { id: PURCHASE_PREFIX + Date.now(), amount };
}
EOF

  cat > src/api/routes.ts <<'EOF'
import express from 'express';
import { createOrder, cancelOrder } from '../services/order';
import { createPurchase } from '../services/purchase';

const router = express.Router();

router.post('/api/orders', async (req, res) => {
  const order = createOrder(req.body);
  res.status(201).json(order);
});

router.delete('/api/orders/:id', async (req, res) => {
  const ok = cancelOrder(req.params.id);
  res.status(ok ? 204 : 404).send();
});

router.get('/api/purchases', async (req, res) => {
  const purchase = createPurchase(Number(req.query.amount));
  res.json(purchase);
});

export default router;
EOF
  git add -A
  git commit -q -m "feat: 新增采购服务与查询路由"

  # ── 提交 5：订单服务改名 + 工具函数重命名（R / M）—— make 到此为止 ──
  git mv src/services/order.ts src/services/order-service.ts

  cat > src/services/order-service.ts <<'EOF'
export interface Order {
  id: string;
  amount: number;
}

export const ORDER_PREFIX = 'ord-';

export function createOrder(input: { amount: number }): Order {
  return { id: ORDER_PREFIX + Date.now(), amount: input.amount };
}

export function cancelOrder(id: string): boolean {
  return id.startsWith(ORDER_PREFIX);
}
EOF

  cat > src/utils/format.ts <<'EOF'
export function formatMoney(cents: number): string {
  return (cents / 100).toFixed(2);
}

export function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
EOF

  cat > src/api/routes.ts <<'EOF'
import express from 'express';
import { createOrder, cancelOrder } from '../services/order-service';
import { createPurchase } from '../services/purchase';

const router = express.Router();

router.post('/api/orders', async (req, res) => {
  const order = createOrder(req.body);
  res.status(201).json(order);
});

router.delete('/api/orders/:id', async (req, res) => {
  const ok = cancelOrder(req.params.id);
  res.status(ok ? 204 : 404).send();
});

router.get('/api/purchases', async (req, res) => {
  const purchase = createPurchase(Number(req.query.amount));
  res.json(purchase);
});

export default router;
EOF

  cat > src/index.ts <<'EOF'
import { createOrder, cancelOrder } from './services/order-service';
import { createUser } from './services/user';
import { formatMoney, fmtDate } from './utils/format';

export function bootstrap() {
  const order = createOrder({ amount: 1299 });
  const user = createUser('demo');
  console.log(formatMoney(order.amount), fmtDate(new Date()), user.id);
  return { order, user };
}

export { cancelOrder };
EOF
  git add -A
  git commit -q -m "refactor: 订单服务改名为 order-service，工具函数统一命名"

  # ── 导出 bare origin ──
  rm -rf "$DEST"
  mkdir -p "$(dirname "$DEST")"
  git clone -q --bare "$SEED" "$DEST"
  git --git-dir="$DEST" symbolic-ref HEAD refs/heads/master

  echo "✅ 已生成 origin（停在 commit 5）: $DEST"
  echo "--- 提交历史（master）---"
  git --git-dir="$DEST" log --oneline master
  echo
  echo "下一步：让 CodeLens 全量索引这个状态，然后执行"
  echo "        $0 advance $DEST"
  exit 0
fi

# ═════════════════════════════ advance ═════════════════════════════
if [ "$MODE" = "advance" ]; then
  [ -d "$DEST" ] || { echo "!! origin 不存在: $DEST（请先执行 make）"; exit 1; }
  cd "$WORK"
  git clone -q "$DEST" work
  cd work
  git config user.email "fixture@codelens.local"
  git config user.name  "CodeLens Fixture"
  git config commit.gpgsign false

  # ── 提交 6：折扣计算 + 折扣路由（A / M）──
  cat > src/services/discount.ts <<'EOF'
export interface Discount {
  tier: string;
  rate: number;
}

export const DISCOUNT_TIERS = ['standard', 'vip', 'svip'];

export function calcDiscount(amount: number, tier: string): number {
  const index = DISCOUNT_TIERS.indexOf(tier);
  return index <= 0 ? amount : amount * (1 - index * 0.05);
}
EOF

  cat > src/services/purchase.ts <<'EOF'
import { calcDiscount } from './discount';

export interface Purchase {
  id: string;
  amount: number;
}

export const PURCHASE_PREFIX = 'pur-';

export function createPurchase(amount: number): Purchase {
  return { id: PURCHASE_PREFIX + Date.now(), amount };
}

export function applyDiscount(amount: number, tier: string): number {
  return calcDiscount(amount, tier);
}
EOF

  cat > src/api/routes.ts <<'EOF'
import express from 'express';
import { createOrder, cancelOrder } from '../services/order-service';
import { createPurchase, applyDiscount } from '../services/purchase';

const router = express.Router();

router.post('/api/orders', async (req, res) => {
  const order = createOrder(req.body);
  res.status(201).json(order);
});

router.delete('/api/orders/:id', async (req, res) => {
  const ok = cancelOrder(req.params.id);
  res.status(ok ? 204 : 404).send();
});

router.get('/api/purchases', async (req, res) => {
  const purchase = createPurchase(Number(req.query.amount));
  res.json(purchase);
});

router.get('/api/discounts', async (req, res) => {
  const price = applyDiscount(Number(req.query.amount), String(req.query.tier));
  res.json({ price });
});

export default router;
EOF
  git add -A
  git commit -q -m "feat: 增加折扣计算与折扣路由"

  # ── 提交 7：用户模块改名 account + 常量改名 + 删 legacy（R / M / D）──
  git mv src/services/user.ts src/services/account.ts

  cat > src/services/order-service.ts <<'EOF'
export interface Order {
  id: string;
  amount: number;
}

export const ORDER_ID_PREFIX = 'ord-';

export function createOrder(input: { amount: number }): Order {
  return { id: ORDER_ID_PREFIX + Date.now(), amount: input.amount };
}

export function cancelOrder(id: string): boolean {
  return id.startsWith(ORDER_ID_PREFIX);
}
EOF

  cat > src/index.ts <<'EOF'
import { createOrder, cancelOrder } from './services/order-service';
import { createUser } from './services/account';
import { formatMoney, fmtDate } from './utils/format';

export function bootstrap() {
  const order = createOrder({ amount: 1299 });
  const user = createUser('demo');
  console.log(formatMoney(order.amount), fmtDate(new Date()), user.id);
  return { order, user };
}

export { cancelOrder };
EOF

  git rm -q src/legacy/old-helper.ts
  git add -A
  git commit -q -m "refactor: 用户模块并入 account，订单前缀改名，移除 legacy 助手"

  git push -q origin master

  echo "✅ 已把 origin 推进 2 个提交: $DEST"
  echo "--- 提交历史（master）---"
  git log --oneline -7
  echo
  echo "--- 上游相对索引状态（commit 5）的差异，应为 7 条 ---"
  git diff --name-status -M HEAD~2 HEAD
  exit 0
fi

echo "!! 未知模式: $MODE（只支持 make / advance）"
exit 1
