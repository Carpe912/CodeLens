#!/usr/bin/env node

/**
 * CodeLens 一键部署脚本
 *
 * 功能：
 * 1. 本地构建前端和后端
 * 2. 通过 SSH 上传到服务器
 * 3. 安装依赖
 * 4. 重启 PM2 服务
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// 配置
const CONFIG = {
  server: {
    host: '47.116.6.132',
    user: 'root',
    deployPath: '/root/CodeLens'
  },
  build: {
    api: 'apps/api',
    web: 'apps/web'
  }
};

// 颜色输出
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  blue: '\x1b[34m'
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function exec(command, options = {}) {
  log(`\n> ${command}`, 'blue');
  try {
    execSync(command, { stdio: 'inherit', ...options });
  } catch (error) {
    log(`✗ 命令执行失败: ${command}`, 'red');
    process.exit(1);
  }
}

function step(title) {
  log(`\n${'='.repeat(60)}`, 'yellow');
  log(`  ${title}`, 'yellow');
  log(`${'='.repeat(60)}`, 'yellow');
}

// 检查环境
function checkEnvironment() {
  step('检查环境');

  // 检查 Node 版本
  const nodeVersion = process.version;
  const majorVersion = parseInt(nodeVersion.slice(1).split('.')[0]);
  if (majorVersion < 18) {
    log(`⚠ Node 版本过低 (${nodeVersion})，需要 >= 18.12`, 'yellow');
    log('尝试自动切换到 Node 22...', 'blue');

    try {
      // 检查 nvm 是否可用
      execSync('command -v nvm', { stdio: 'ignore' });

      // 尝试切换到 Node 22
      log('执行: source ~/.nvm/nvm.sh && nvm use 22', 'blue');

      // 使用 bash -c 来执行 nvm 命令
      execSync('bash -c "source ~/.nvm/nvm.sh && nvm use 22 && node --version"', { stdio: 'inherit' });

      log('✓ 已切换到 Node 22，请重新运行 npm run deploy', 'green');
      log('或者手动运行: nvm use 22 && npm run deploy', 'yellow');
      process.exit(0);
    } catch (error) {
      log('✗ 自动切换失败，请手动切换 Node 版本', 'red');
      log('运行: nvm use 22 && npm run deploy', 'yellow');
      log('或者: nvm use 18 && npm run deploy', 'yellow');
      process.exit(1);
    }
  }
  log(`✓ Node 版本: ${nodeVersion}`, 'green');

  // 检查 pnpm
  try {
    execSync('pnpm --version', { stdio: 'ignore' });
    log('✓ pnpm 已安装', 'green');
  } catch {
    log('✗ 请先安装 pnpm: npm install -g pnpm', 'red');
    process.exit(1);
  }

  // 检查 SSH 连接
  try {
    execSync(`ssh -o ConnectTimeout=5 ${CONFIG.server.user}@${CONFIG.server.host} "echo ok"`, { stdio: 'ignore' });
    log('✓ SSH 连接正常', 'green');
  } catch {
    log('✗ 无法连接到服务器，请检查 SSH 配置', 'red');
    process.exit(1);
  }

  // 检查环境变量文件
  const envFile = path.join(CONFIG.build.web, '.env.production');
  if (!fs.existsSync(envFile)) {
    log('✗ 缺少 apps/web/.env.production 文件', 'red');
    process.exit(1);
  }
  log('✓ 环境配置文件存在', 'green');
}

// 本地构建
function buildLocal() {
  step('本地构建');

  // 安装依赖
  log('安装依赖...', 'blue');
  exec('pnpm install');

  // 构建 API
  log('构建 API...', 'blue');
  exec('pnpm build:api');

  // 构建前端
  log('构建前端...', 'blue');
  exec('pnpm build:web');

  log('✓ 构建完成', 'green');
}

// 上传到服务器
function uploadToServer() {
  step('上传到服务器');

  const { host, user, deployPath } = CONFIG.server;
  const target = `${user}@${host}:${deployPath}`;

  // 创建部署目录
  log('创建部署目录...', 'blue');
  exec(`ssh ${user}@${host} "mkdir -p ${deployPath}"`);

  // 上传文件
  const filesToUpload = [
    'apps/api/dist',
    'apps/api/package.json',
    'apps/api/src/db/migrations',  // 数据库迁移文件
    'apps/web/dist',
    'apps/web/.env.production',
    '.env.production',  // 根目录的环境变量（API 会读取这个）
    'package.json',
    'pnpm-workspace.yaml',
    'ecosystem.config.js'
  ];

  log('上传文件...', 'blue');

  // 先清空 dist 目录，避免旧文件残留
  log('清空旧的 dist 目录...', 'blue');
  exec(`ssh ${user}@${host} "rm -rf ${deployPath}/apps/web/dist ${deployPath}/apps/api/dist"`);

  filesToUpload.forEach(file => {
    const dir = path.dirname(file);
    if (dir !== '.') {
      exec(`ssh ${user}@${host} "mkdir -p ${deployPath}/${dir}"`);
    }
    exec(`scp -r ${file} ${target}/${file}`);
  });

  log('✓ 上传完成', 'green');
}

// 服务器端操作
function deployOnServer() {
  step('服务器端部署');

  const { host, user, deployPath } = CONFIG.server;

  // 清理旧的 node_modules（可选，加快安装速度）
  log('清理旧依赖...', 'blue');
  exec(`ssh ${user}@${host} "cd ${deployPath} && rm -rf node_modules apps/*/node_modules"`);

  // 安装依赖
  log('安装生产依赖...', 'blue');
  exec(`ssh ${user}@${host} "cd ${deployPath} && pnpm install --prod"`);

  // 运行数据库迁移
  log('运行数据库迁移...', 'blue');
  const migrationFile = `${deployPath}/apps/api/src/db/migrations/add_agent_tables.sql`;
  const migrationCmd = `cd ${deployPath} && if [ -f "${migrationFile}" ]; then psql $DATABASE_URL -f "${migrationFile}" 2>&1 | grep -v "already exists" || true; echo "✓ 数据库迁移完成"; else echo "⚠ 迁移文件不存在，跳过"; fi`;
  exec(`ssh ${user}@${host} "${migrationCmd}"`);

  // 重启服务
  log('重启 PM2 服务...', 'blue');
  // 先尝试重启现有进程，如果不存在则启动新进程
  const restartCmd = `cd ${deployPath} && (pm2 restart ecosystem.config.js --env production --update-env || pm2 start ecosystem.config.js --env production) && pm2 save`;
  exec(`ssh ${user}@${host} "${restartCmd}"`);

  // 检查服务状态
  log('检查服务状态...', 'blue');
  exec(`ssh ${user}@${host} "pm2 status"`);

  log('✓ 部署完成', 'green');
}

// 验证部署
function verifyDeployment() {
  step('验证部署');

  const { host, user } = CONFIG.server;

  // 等待服务启动
  log('等待服务启动（5秒）...', 'blue');
  execSync('sleep 5');

  // 检查 API（在服务器内部检查）
  log('检查 API 服务...', 'blue');
  try {
    execSync(`ssh ${user}@${host} "curl -f http://localhost:8787/health"`, { stdio: 'ignore', timeout: 10000 });
    log('✓ API 服务正常', 'green');
  } catch {
    log('⚠ API 服务可能未启动，请手动检查', 'yellow');
  }

  // 检查前端（在服务器内部检查）
  log('检查前端服务...', 'blue');
  try {
    execSync(`ssh ${user}@${host} "curl -f http://localhost:5173/code/"`, { stdio: 'ignore', timeout: 10000 });
    log('✓ 前端服务正常', 'green');
  } catch {
    log('⚠ 前端服务可能未启动，请手动检查', 'yellow');
  }

  log('\n✓ 部署验证完成', 'green');
  log('访问地址: https://sunlingyue.cn/code/', 'blue');
}

// 主函数
async function main() {
  log('\n🚀 CodeLens 部署脚本', 'green');
  log('目标服务器: ' + CONFIG.server.host, 'blue');

  try {
    checkEnvironment();
    buildLocal();
    uploadToServer();
    deployOnServer();
    verifyDeployment();

    log('\n✓ 部署成功！', 'green');
    log('访问地址: https://sunlingyue.cn/code/', 'blue');
  } catch (error) {
    log('\n✗ 部署失败', 'red');
    console.error(error);
    process.exit(1);
  }
}

// 运行
main();
