#!/usr/bin/expect -f

# CodeLens 自动部署脚本 (使用 expect，无需 sshpass)
# 服务器: 47.116.6.132

set timeout -1
set SERVER_IP "47.116.6.132"
set SERVER_USER "admin"
set SERVER_PASSWORD "Sunlingyao0912"
set DEPLOY_DIR "/home/admin/codelens"

puts "🚀 开始部署 CodeLens 到服务器 $SERVER_IP..."

# 1. 打包项目
puts "📦 打包项目..."
spawn bash -c "tar -czf codelens-deploy.tar.gz --exclude=node_modules --exclude=.git --exclude=dist --exclude=.turbo --exclude=apps/web/dist --exclude=apps/api/dist ."
expect eof

# 2. 上传到服务器
puts "📤 上传文件到服务器..."
spawn scp -o StrictHostKeyChecking=no codelens-deploy.tar.gz ${SERVER_USER}@${SERVER_IP}:/tmp/
expect {
    "password:" {
        send "$SERVER_PASSWORD\r"
        expect eof
    }
    eof
}

# 3. 在服务器上执行部署
puts "🔧 在服务器上执行部署..."
spawn ssh -o StrictHostKeyChecking=no ${SERVER_USER}@${SERVER_IP}
expect "password:"
send "$SERVER_PASSWORD\r"

expect "$ "
send "export NVM_DIR=\"\$HOME/.nvm\"\r"
expect "$ "
send "\[ -s \"\$NVM_DIR/nvm.sh\" \] && \\. \"\$NVM_DIR/nvm.sh\"\r"
expect "$ "
send "nvm use 22\r"
expect "$ "
send "mkdir -p $DEPLOY_DIR\r"
expect "$ "
send "cd $DEPLOY_DIR\r"
expect "$ "
send "tar -xzf /tmp/codelens-deploy.tar.gz -C $DEPLOY_DIR\r"
expect "$ "
send "rm /tmp/codelens-deploy.tar.gz\r"
expect "$ "
send "command -v pnpm &> /dev/null || npm install -g pnpm\r"
expect "$ "
send "command -v pm2 &> /dev/null || npm install -g pm2\r"
expect "$ "
send "pnpm install\r"
expect "$ "
send "pnpm build\r"
expect "$ "
send "cp .env.production .env\r"
expect "$ "
send "pm2 delete codelens-api codelens-web || true\r"
expect "$ "
send "cd apps/api && pm2 start dist/index.js --name codelens-api --env production\r"
expect "$ "
send "cd ../web && npm install -g serve && pm2 start \"serve -s dist -l 5173\" --name codelens-web\r"
expect "$ "
send "pm2 save\r"
expect "$ "
send "pm2 status\r"
expect "$ "
send "exit\r"
expect eof

# 4. 清理本地临时文件
puts "🧹 清理临时文件..."
spawn rm codelens-deploy.tar.gz
expect eof

puts "✅ 部署完成！"
puts ""
puts "🌐 访问地址："
puts "  - API: http://47.116.6.132:8787"
puts "  - Web: http://47.116.6.132:5173"
