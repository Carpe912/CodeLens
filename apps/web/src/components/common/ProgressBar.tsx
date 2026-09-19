import { IndexProgress } from '../../types';

type ProgressBarProps = {
  progress: IndexProgress;
};

export function ProgressBar({ progress }: ProgressBarProps) {
  const { percentComplete, processed, total, phase } = progress;

  const phaseText = phase === 'enhanced' ? '增强索引' : '基础索引';

  return (
    <div className="mt-2 space-y-1">
      <div className="flex justify-between text-xs text-gray-400">
        <span>{phaseText}: {processed} / {total} 文件</span>
        <span>{percentComplete}%</span>
      </div>
      <div className="w-full bg-slate-700 rounded-full h-2 overflow-hidden relative">
        <div
          className="absolute inset-0 bg-gradient-to-r from-blue-500 to-cyan-400 h-full transition-all duration-500 ease-in-out"
          style={{
            width: `${percentComplete}%`,
            animation: 'progress-pulse 2s ease-in-out infinite'
          }}
        />
        <div
          className="absolute inset-0 bg-gradient-to-r from-transparent via-white/30 to-transparent h-full"
          style={{
            width: '30%',
            animation: 'progress-shimmer 2s ease-in-out infinite',
            left: '-30%'
          }}
        />
      </div>
      <style>{`
        @keyframes progress-pulse {
          0%, 100% {
            opacity: 1;
          }
          50% {
            opacity: 0.8;
          }
        }

        @keyframes progress-shimmer {
          0% {
            left: -30%;
          }
          100% {
            left: 100%;
          }
        }
      `}</style>
    </div>
  );
}
