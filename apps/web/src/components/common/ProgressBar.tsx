import { IndexProgress } from '../../types';

type ProgressBarProps = {
  progress: IndexProgress;
};

export function ProgressBar({ progress }: ProgressBarProps) {
  const { percentComplete, processed, total, estimatedTimeRemaining } = progress;

  const formatTime = (seconds: number | null) => {
    if (seconds === null) return '计算中...';
    if (seconds < 60) return `${seconds}秒`;
    if (seconds < 3600) return `${Math.round(seconds / 60)}分钟`;
    return `${Math.round(seconds / 3600)}小时`;
  };

  return (
    <div className="mt-2 space-y-1">
      <div className="flex justify-between text-xs text-gray-400">
        <span>{processed} / {total} 文件</span>
        <span>{percentComplete}%</span>
      </div>
      <div className="w-full bg-slate-700 rounded-full h-2 overflow-hidden">
        <div
          className="bg-gradient-to-r from-blue-500 to-cyan-400 h-full transition-all duration-300 ease-out"
          style={{ width: `${percentComplete}%` }}
        />
      </div>
      {estimatedTimeRemaining !== null && (
        <div className="text-xs text-gray-500">
          预计剩余: {formatTime(estimatedTimeRemaining)}
        </div>
      )}
    </div>
  );
}
