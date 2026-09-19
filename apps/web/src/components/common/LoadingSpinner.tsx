/**
 * 加载指示器。
 *
 * `className` 用来覆盖尺寸/颜色 —— 默认的蓝色 spinner 放进蓝色按钮里是**看不见**的
 * （同色叠加），提交按钮里必须传浅色（如 `border-white`）。这个 prop 就是为它加的。
 */
type LoadingSpinnerProps = {
  className?: string;
};

export function LoadingSpinner({ className = 'h-8 w-8 border-blue-600' }: LoadingSpinnerProps) {
  return (
    <div className="flex items-center justify-center">
      <div className={`animate-spin rounded-full border-b-2 ${className}`} />
    </div>
  );
}
