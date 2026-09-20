import React from 'react';

/**
 * 浅色纸面卡片：内容区的统一容器（从 RepoPage 抽出的通用原语）。
 * 命令条是深色的，内容区一律用它 —— 两层视觉语言靠这两个组件钉住。
 */
export function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <section className={`bg-white rounded-xl border border-slate-200 shadow-sm ${className}`}>
      {children}
    </section>
  );
}

/** 卡片头：图标 + 标题 + 右侧插槽 */
export function CardHeader({
  title,
  icon,
  iconClass,
  subtitle,
  right,
}: {
  title: string;
  icon: React.ReactNode;
  iconClass: string;
  subtitle?: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 border-b border-slate-100">
      <div className="flex items-center gap-3 min-w-0">
        <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${iconClass}`}>
          {icon}
        </div>
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-slate-900">{title}</h2>
          {subtitle && <div className="text-xs text-slate-500 mt-0.5">{subtitle}</div>}
        </div>
      </div>
      {right}
    </div>
  );
}
