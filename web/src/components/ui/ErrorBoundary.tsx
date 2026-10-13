import { Component, type ReactNode } from "react";

/** 错误边界：任一子树（尤其图表）抛错时局部降级，避免整页白屏。 */
export class ErrorBoundary extends Component<
  { children: ReactNode; fallback?: ReactNode; label?: string },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    // 保留到控制台便于排查，但不影响其它区域
    console.error("[ErrorBoundary]", this.props.label || "", error);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex min-h-[80px] flex-col items-center justify-center gap-1 rounded-md border border-dashed border-border p-4 text-center">
          <span className="text-xs text-muted-foreground">
            {this.props.label ? `${this.props.label} 渲染出错` : "该区域渲染出错"}
          </span>
          <button
            className="text-[11px] text-primary hover:underline"
            onClick={() => this.setState({ error: null })}
          >
            重试
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
