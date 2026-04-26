module.exports = {
  apps: [
    {
      name: 'codelens-api',
      script: './apps/api/dist/index.js',
      cwd: '/opt/codelens',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        PORT: 8787,
      },
      error_file: '/var/log/codelens/api-error.log',
      out_file: '/var/log/codelens/api-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      max_memory_restart: '1G',
    },
    {
      name: 'codelens-web',
      script: 'serve',
      args: '-s dist -l 5173',
      cwd: '/opt/codelens/apps/web',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
      },
      error_file: '/var/log/codelens/web-error.log',
      out_file: '/var/log/codelens/web-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
      autorestart: true,
    },
  ],
};
