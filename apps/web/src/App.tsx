import { lazy, Suspense } from 'react';
import { Routes, Route } from 'react-router-dom';
import { LoadingSpinner } from './components/common/LoadingSpinner';

/**
 * 三个页面都改成路由级懒加载。
 *
 * 为什么：原来三个页面是静态 import，vite 只能打成一个 696KB 的 chunk ——
 * 打开首页也要先把 RepoPage 的 prism / react-markdown / monaco 包装层全部下载完。
 * 拆开之后：
 *   - 首页（/）：只拿 react 运行时 + 仓库列表；
 *   - 仓库页（/repo/:id）：按需拉取 markdown/prism 那一坨；
 *   - 调用图页：只在真的点进图视图时才加载 reactflow（它还很大）。
 * 这些都是「用户没走到就不该付钱」的依赖，所以用 lazy 而不是 manualChunks 硬拆。
 */
const HomePage = lazy(() => import('./pages/HomePage').then((m) => ({ default: m.HomePage })));
const RepoPage = lazy(() => import('./pages/RepoPage').then((m) => ({ default: m.RepoPage })));
const CallGraphPage = lazy(() =>
  import('./pages/CallGraphPage').then((m) => ({ default: m.CallGraphPage }))
);

/** 懒加载期间的占位：不做骨架屏，只保证「没有白屏」 */
function RouteFallback() {
  return (
    <div className="min-h-screen bg-slate-100 flex items-center justify-center">
      <div className="flex flex-col items-center gap-3">
        <LoadingSpinner className="h-6 w-6 border-cyan-600" />
        <span className="text-xs text-slate-500">正在加载…</span>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <Suspense fallback={<RouteFallback />}>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/repo/:id" element={<RepoPage />} />
        <Route path="/repo/:id/call-graph/:symbolName" element={<CallGraphPage />} />
      </Routes>
    </Suspense>
  );
}
