
import clsx from "clsx";

interface SkeletonProps {
  className?: string;
  variant?: "text" | "circular" | "rectangular" | "rounded";
  width?: string | number;
  height?: string | number;
  animation?: "pulse" | "wave";
}

export function Skeleton({
  className,
  variant = "text",
  width,
  height,
  animation = "pulse",
}: SkeletonProps) {
  const baseClasses = "bg-surface-2/60";
  const animationClasses =
    animation === "pulse" ? "animate-pulse" : "animate-shimmer";

  const variantClasses = {
    text: "rounded h-4",
    circular: "rounded-full",
    rectangular: "rounded-none",
    rounded: "rounded-xl",
  };

  return (
    <div
      className={clsx(
        baseClasses,
        animationClasses,
        variantClasses[variant],
        className,
      )}
      style={{
        width: width || (variant === "text" ? "100%" : undefined),
        minHeight: height || (variant === "circular" ? width : undefined),
        height: variant === "circular" ? (height ?? width) : undefined,
      }}
    />
  );
}

// Preset skeleton components for common use cases
export function DatasetCardSkeleton() {
  return (
    <div className="glass-card p-6 animate-pulse">
      <div className="flex justify-between items-start mb-4">
        <Skeleton variant="rounded" width={80} height={24} />
        <div className="text-right">
          <Skeleton variant="text" width={60} height={12} className="mb-1" />
          <Skeleton variant="text" width={50} height={20} />
        </div>
      </div>
      <Skeleton variant="text" width="90%" height={20} className="mb-2" />
      <Skeleton variant="text" width="100%" height={16} className="mb-1" />
      <Skeleton variant="text" width="75%" height={16} className="mb-5" />
      <div className="flex items-center gap-4 mb-5">
        <Skeleton variant="text" width={80} height={14} />
        <div className="w-px h-3 bg-border" />
        <Skeleton variant="text" width={100} height={14} />
      </div>
      <div className="mb-5">
        <Skeleton variant="text" width="100%" height={12} className="mb-1.5" />
        <Skeleton variant="rounded" width="100%" height={6} />
      </div>
      <Skeleton variant="rounded" width="100%" height={48} />
    </div>
  );
}

export function StatCardSkeleton() {
  return (
    <div className="glass-card-gold p-5 animate-pulse">
      <div className="flex items-start justify-between mb-3">
        <Skeleton variant="rounded" width={40} height={40} />
        <Skeleton variant="rounded" width={50} height={24} />
      </div>
      <Skeleton variant="text" width={120} height={32} className="mb-1" />
      <Skeleton variant="text" width={100} height={12} />
    </div>
  );
}

export function TransactionRowSkeleton() {
  return (
    <div className="flex items-center gap-3 p-3 rounded-xl bg-surface-2/40 border border-border/20 animate-pulse">
      <Skeleton variant="rounded" width={32} height={32} />
      <div className="flex-1 min-w-0">
        <Skeleton variant="text" width="60%" height={12} className="mb-1" />
        <Skeleton variant="text" width="80%" height={12} />
      </div>
      <div className="text-right flex-shrink-0">
        <Skeleton variant="text" width={60} height={14} className="mb-1" />
        <Skeleton variant="text" width={50} height={12} />
      </div>
    </div>
  );
}

export function TableRowSkeleton({ columns = 4 }: { columns?: number }) {
  return (
    <div className="flex items-center gap-4 p-4 border-b border-border/30 animate-pulse">
      {Array.from({ length: columns }).map((_, i) => (
        <Skeleton
          key={i}
          variant="text"
          width={`${100 / columns}%`}
          height={16}
        />
      ))}
    </div>
  );
}

export function ChartSkeleton() {
  return (
    <div className="glass-card p-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex-1">
          <Skeleton variant="text" width={180} height={20} className="mb-1" />
          <Skeleton variant="text" width={140} height={12} />
        </div>
        <Skeleton variant="circular" width={20} height={20} />
      </div>
      <div className="space-y-3">
        {Array.from({ length: 7 }).map((_, i) => (
          <div key={i} className="flex items-end gap-2" style={{ height: 40 }}>
            <Skeleton
              variant="rectangular"
              width="14%"
              height={`${20 + Math.random() * 80}%`}
              className="rounded-t"
            />
          </div>
        ))}
      </div>
    </div>
  );
}

export function AgentResultSkeleton() {
  return (
    <div className="glass-card p-6 animate-pulse space-y-4">
      <Skeleton variant="text" width="33%" height={20} />
      <Skeleton variant="text" width="100%" height={16} />
      <Skeleton variant="text" width="83%" height={16} />
      <div className="grid grid-cols-3 gap-4 pt-2">
        <Skeleton variant="rounded" width="100%" height={80} />
        <Skeleton variant="rounded" width="100%" height={80} />
        <Skeleton variant="rounded" width="100%" height={80} />
      </div>
    </div>
  );
}
