import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: '/code/',
  build: {
    rollupOptions: {
      output: {
        /**
         * 只拆「多个懒加载页共享」的 vendor：
         *   react-vendor —— 运行时，几乎不随业务改动变，单独一块能吃住缓存；
         *   graph        —— reactflow 被「调用图页」和「仓库页的调用图弹窗」共享，
         *                   拆出来两边只下载一次。
         *
         * ⚠️ 不要把「只被某一个懒加载页用」的包（react-markdown / remark-gfm / prismjs）
         *    写成手动分组。实测（2026-09-19）：给它们建 `markdown` 分组后，入口 chunk
         *    会静态依赖该分组，index.html 里就多出一条 176KB 的 modulepreload ——
         *    首屏白白下载一次，把懒加载的好处抵掉了。让 Rollup 自动分包即可：
         *    它们会留在 RepoPage 那个懒 chunk 里（~305KB），照样是「进仓库页才下」。
         *    判据：构建后 `grep modulepreload dist/index.html` 只应出现 react-vendor。
         */
        manualChunks: {
          'react-vendor': ['react', 'react-dom', 'react-router-dom'],
          graph: ['reactflow'],
        },
      },
    },
    // 拆完单块最大 ~305KB（懒加载的 RepoPage）；设 600 留余量，超了就该告警
    chunkSizeWarningLimit: 600,
  },
});
