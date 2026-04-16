import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeSnippet } from "./CodeSnippet";

interface MarkdownTextProps {
  text: string;
}

function detectLanguage(className: string | undefined): string {
  if (!className) return "text";
  const prefix = "language-";
  if (!className.startsWith(prefix)) return "text";
  const name = className.slice(prefix.length).trim();
  return name.length > 0 ? name : "text";
}

const components: Components = {
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children }) => {
    const code = String(children ?? "");
    const isBlock =
      code.includes("\n") || (className?.startsWith("language-") ?? false);

    if (!isBlock) {
      return (
        <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em]">
          {code}
        </code>
      );
    }

    return (
      <CodeSnippet
        code={code.replace(/\n$/, "")}
        language={detectLanguage(className)}
      />
    );
  },
  p: ({ children }) => <p className="whitespace-pre-wrap">{children}</p>,
  ul: ({ children }) => (
    <ul className="my-3 list-disc space-y-2 pl-5 marker:text-muted-foreground/80">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="my-3 list-decimal space-y-2 pl-5 marker:font-medium marker:text-muted-foreground/80">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="pl-1 leading-7">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="my-4 border-l-2 border-border pl-3 italic text-muted-foreground">
      {children}
    </blockquote>
  ),
};

function MarkdownTextComponent({ text }: MarkdownTextProps) {
  return (
    <div className="markdown-content text-sm leading-relaxed text-foreground break-words">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

export const MarkdownText = memo(MarkdownTextComponent);
