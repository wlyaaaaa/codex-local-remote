import { Button } from "@codex-local-remote/ui";

export function PaginationFooter({
  completeLabel,
  error,
  hasMore,
  label,
  loading,
  onLoadMore,
}: {
  completeLabel: string;
  error: string;
  hasMore: boolean;
  label: string;
  loading: boolean;
  onLoadMore: () => void;
}) {
  return (
    <div className="pagination-footer" data-testid="pagination-footer">
      {error ? <p role="alert">{error}</p> : null}
      {hasMore || Boolean(error) ? (
        <Button
          data-testid="pagination-load-more"
          disabled={loading}
          icon={loading ? "activity" : "clock"}
          onClick={onLoadMore}
        >
          {loading ? "正在加载…" : error ? "重试加载" : label}
        </Button>
      ) : (
        <span className="pagination-complete">{completeLabel}</span>
      )}
    </div>
  );
}
