import { memo, useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { highlightCode } from "@/lib/highlight";
import { cn } from "@/lib/utils";

interface CodeBlockProps {
  code: string;
  language?: string;
  className?: string;
}

/** 单块代码：异步高亮，未就绪时先显示纯文本，避免闪烁空块。 */
function CodeBlock({ code, language, className }: CodeBlockProps) {
  const [html, setHtml] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    void highlightCode(code, language).then((h) => {
      if (alive) setHtml(h);
    });
    return () => {
      alive = false;
    };
  }, [code, language]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // 剪贴板在 Wayland 下可能被拒绝，静默失败即可。
    }
  };

  return (
    <div className={cn("group relative my-2", className)}>
      <button
        type="button"
        onClick={copy}
        className="absolute right-2 top-2 z-10 rounded border border-border-subtle bg-surface-raised/90 px-1.5 py-0.5 text-[10px] text-ink-muted opacity-0 transition group-hover:opacity-100"
      >
        {copied ? "已复制" : "复制"}
      </button>
      {html ? (
        // shiki 输出的是受控 HTML（来自本地 grammar，无外部输入拼接）。
        <div
          className="md-pre-wrap overflow-x-auto rounded-lg border border-border-subtle text-[12.5px] leading-relaxed [&>pre]:!m-0 [&>pre]:!bg-surface-sunken [&>pre]:!p-3"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre className="overflow-x-auto rounded-lg border border-border-subtle bg-surface-sunken p-3 text-[12.5px] leading-relaxed">
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
}

interface MarkdownProps {
  children: string;
  /** 流式输出中：末尾追加光标。 */
  streaming?: boolean;
  className?: string;
}

export const Markdown = memo(function Markdown({ children, streaming, className }: MarkdownProps) {
  const components = useMemo(
    () => ({
      // 代码块：react-markdown 会把 <pre><code> 分开给，这里统一在 code 层处理。
      code({ className: cls, children: kids, ...rest }: any) {
        const text = String(kids ?? "").replace(/\n$/, "");
        const match = /language-([\w+-]+)/.exec(cls ?? "");
        // 行内代码没有 language- 前缀且不含换行。
        if (!match && !text.includes("\n")) {
          return (
            <code className={cls} {...rest}>
              {kids}
            </code>
          );
        }
        return <CodeBlock code={text} language={match?.[1]} />;
      },
      pre({ children: kids }: any) {
        // 由 code 组件自己渲染容器，这里直接下沉。
        return <>{kids}</>;
      },
      a({ href, children: kids }: any) {
        // 外链走系统浏览器，不在 WebView 内导航（会丢 IPC 上下文）。
        return (
          <a
            href={href}
            onClick={(e) => {
              e.preventDefault();
              if (href) void import("@tauri-apps/plugin-opener").then((m) => m.openUrl(href));
            }}
          >
            {kids}
          </a>
        );
      },
    }),
    [],
  );

  return (
    <div className={cn("md", streaming && "caret", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
});
