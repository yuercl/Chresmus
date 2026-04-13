import React, { memo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronRight, FilePlus, FileMinus, FileEdit } from "lucide-react";
import { Button } from "@/components/ui/button";

interface FileChange {
  path: string;
  kind: { type: string; movePath?: string | null | undefined };
  diff?: string | undefined;
}

interface DiffBlockProps {
  changes: FileChange[];
  layout?: "traditional" | "split";
}

type LineType = "add" | "remove" | "header" | "context" | "empty";

interface UnifiedDiffLine {
  type: Exclude<LineType, "empty">;
  content: string;
}

interface DiffSideLine {
  type: LineType;
  content: string;
  lineNumber: number | null;
}

type SideBySideDiffRow =
  | {
      kind: "meta";
      content: string;
    }
  | {
      kind: "pair";
      left: DiffSideLine;
      right: DiffSideLine;
    };

function parseHunkStart(line: string): {
  leftLineNumber: number;
  rightLineNumber: number;
} | null {
  const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  if (!match) {
    return null;
  }
  const leftStart = match[1];
  const rightStart = match[2];
  if (!leftStart || !rightStart) {
    return null;
  }
  const leftLineNumber = Number.parseInt(leftStart, 10);
  const rightLineNumber = Number.parseInt(rightStart, 10);
  return {
    leftLineNumber,
    rightLineNumber,
  };
}

function parseUnifiedDiff(raw: string): UnifiedDiffLine[] {
  const result: UnifiedDiffLine[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("diff --git")) {
      result.push({ type: "header", content: line });
    } else if (line.startsWith("@@")) {
      result.push({ type: "header", content: line });
    } else if (line.startsWith("+++")) {
      result.push({ type: "header", content: line });
    } else if (line.startsWith("---")) {
      result.push({ type: "header", content: line });
    } else if (line.startsWith("+")) {
      result.push({ type: "add", content: line.slice(1) });
    } else if (line.startsWith("-")) {
      result.push({ type: "remove", content: line.slice(1) });
    } else {
      const content = line.startsWith(" ") ? line.slice(1) : line;
      if (content) result.push({ type: "context", content });
    }
  }
  return result;
}

function parseSideBySideDiff(raw: string): SideBySideDiffRow[] {
  const rows: SideBySideDiffRow[] = [];
  const lines = raw.split("\n");
  let index = 0;
  let leftLineNumber = 0;
  let rightLineNumber = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";

    if (
      line.startsWith("diff --git") ||
      line.startsWith("index ") ||
      line.startsWith("---") ||
      line.startsWith("+++")
    ) {
      rows.push({ kind: "meta", content: line });
      index += 1;
      continue;
    }

    if (line.startsWith("@@")) {
      const hunkStart = parseHunkStart(line);
      if (hunkStart) {
        leftLineNumber = hunkStart.leftLineNumber;
        rightLineNumber = hunkStart.rightLineNumber;
      }
      rows.push({ kind: "meta", content: line });
      index += 1;
      continue;
    }

    if (line.startsWith("\\")) {
      rows.push({ kind: "meta", content: line });
      index += 1;
      continue;
    }

    if (line.startsWith("-")) {
      const nextLine = lines[index + 1] ?? "";
      if (nextLine.startsWith("+")) {
        rows.push({
          kind: "pair",
          left: {
            type: "remove",
            content: line.slice(1),
            lineNumber: leftLineNumber,
          },
          right: {
            type: "add",
            content: nextLine.slice(1),
            lineNumber: rightLineNumber,
          },
        });
        leftLineNumber += 1;
        rightLineNumber += 1;
        index += 2;
        continue;
      }

      rows.push({
        kind: "pair",
        left: {
          type: "remove",
          content: line.slice(1),
          lineNumber: leftLineNumber,
        },
        right: {
          type: "empty",
          content: "",
          lineNumber: null,
        },
      });
      leftLineNumber += 1;
      index += 1;
      continue;
    }

    if (line.startsWith("+")) {
      rows.push({
        kind: "pair",
        left: {
          type: "empty",
          content: "",
          lineNumber: null,
        },
        right: {
          type: "add",
          content: line.slice(1),
          lineNumber: rightLineNumber,
        },
      });
      rightLineNumber += 1;
      index += 1;
      continue;
    }

    const content = line.startsWith(" ") ? line.slice(1) : line;
    rows.push({
      kind: "pair",
      left: {
        type: "context",
        content,
        lineNumber: leftLineNumber,
      },
      right: {
        type: "context",
        content,
        lineNumber: rightLineNumber,
      },
    });
    leftLineNumber += 1;
    rightLineNumber += 1;
    index += 1;
  }

  return rows;
}

function kindMeta(kind: string) {
  if (kind === "create")
    return { Icon: FilePlus, label: "created", cls: "text-success" };
  if (kind === "delete")
    return { Icon: FileMinus, label: "deleted", cls: "text-danger" };
  return {
    Icon: FileEdit,
    label: "modified",
    cls: "text-blue-400 dark:text-blue-400",
  };
}

const LINE_STYLES: Record<LineType, string> = {
  add: "bg-success/8 dark:bg-success/10",
  remove: "bg-danger/8 dark:bg-danger/10",
  header: "bg-muted/60",
  context: "",
  empty: "bg-muted/20",
};
const TEXT_STYLES: Record<LineType, string> = {
  add: "text-success dark:text-success/90",
  remove: "text-danger dark:text-danger/90",
  header: "text-muted-foreground/60 italic",
  context: "text-foreground/70",
  empty: "text-muted-foreground/20",
};
const GUTTER_STYLES: Record<LineType, string> = {
  add: "text-success/50",
  remove: "text-danger/50",
  header: "text-muted-foreground/30",
  context: "text-muted-foreground/25",
  empty: "text-muted-foreground/20",
};
const GUTTER_CHAR: Record<LineType, string> = {
  add: "+",
  remove: "−",
  header: "",
  context: " ",
  empty: " ",
};

function DiffBlockComponent({
  changes,
  layout = "traditional",
}: DiffBlockProps) {
  const [expandedIdx, setExpandedIdx] = useState<number | null>(
    changes.length === 1 || (changes.length > 0 && changes[0]?.diff == null)
      ? 0
      : null,
  );
  const lastDiffLengthRef = React.useRef(changes[0]?.diff?.length ?? 0);

  React.useEffect(() => {
    if (changes.length > 0) {
      const currentDiffLength = changes[0]?.diff?.length ?? 0;
      const prevDiffLength = lastDiffLengthRef.current;

      if (currentDiffLength > 0 && prevDiffLength === 0) {
        setExpandedIdx(null);
      }
      lastDiffLengthRef.current = currentDiffLength;
    }
  }, [changes]);

  return (
    <div className="rounded-xl border border-border overflow-hidden text-sm">
      {changes.map((change, i) => {
        const isExpanded = expandedIdx === i;
        const fileName = change.path.split("/").pop() ?? change.path;
        const dirPath = change.path.slice(0, change.path.lastIndexOf("/"));
        const unifiedLines = change.diff ? parseUnifiedDiff(change.diff) : [];
        const added = unifiedLines.filter((line) => line.type === "add").length;
        const removed = unifiedLines.filter((line) => line.type === "remove").length;
        const { Icon, label, cls } = kindMeta(change.kind.type);

        return (
          <div key={i} className={i > 0 ? "border-t border-border" : ""}>
            <Button
              type="button"
              onClick={() => setExpandedIdx(isExpanded ? null : i)}
              variant="ghost"
              className="h-auto w-full justify-start rounded-none bg-muted/40 px-3 py-2.5 text-left transition-colors hover:bg-muted/70"
            >
              <Icon size={12} className={`shrink-0 ${cls}`} />
              <span className="font-mono text-xs font-medium text-foreground truncate">
                {fileName}
              </span>
              {dirPath && (
                <span className="text-[11px] text-muted-foreground/40 truncate hidden sm:block">
                  {dirPath}
                </span>
              )}
              <div className="flex items-center gap-2 ml-auto shrink-0">
                {added > 0 && (
                  <span className="text-xs font-mono text-success">
                    +{added}
                  </span>
                )}
                {removed > 0 && (
                  <span className="text-xs font-mono text-danger">
                    −{removed}
                  </span>
                )}
                <span className={`text-[10px] font-medium ${cls}`}>
                  {label}
                </span>
                <ChevronRight
                  size={11}
                  className={`text-muted-foreground/50 transition-transform duration-150 ${isExpanded ? "rotate-90" : ""}`}
                />
              </div>
            </Button>

            <AnimatePresence initial={false}>
              {isExpanded && (
                <motion.div
                  key={`diff-${i}`}
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.24, ease: "easeInOut" }}
                  className="overflow-hidden"
                >
                  <div className="border-t border-border overflow-x-auto">
                    {change.diff ? (
                      layout === "split" ? (
                        <SplitDiffView raw={change.diff} />
                      ) : (
                        <TraditionalDiffView lines={unifiedLines} />
                      )
                    ) : (
                      <div className="px-3 py-2 text-xs text-muted-foreground">
                        No diff available
                      </div>
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        );
      })}
    </div>
  );
}

function TraditionalDiffView({
  lines,
}: {
  lines: UnifiedDiffLine[];
}): React.JSX.Element {
  return (
    <>
      {lines.map((line, index) => (
        <div
          key={`${line.type}-${index}`}
          className={`flex font-mono text-xs leading-5 ${LINE_STYLES[line.type]}`}
        >
          <span
            className={`select-none w-6 text-center text-[10px] shrink-0 pt-px ${GUTTER_STYLES[line.type]}`}
          >
            {GUTTER_CHAR[line.type]}
          </span>
          <span
            className={`flex-1 px-2 py-0.5 whitespace-pre-wrap break-all ${TEXT_STYLES[line.type]}`}
          >
            {line.content}
          </span>
        </div>
      ))}
    </>
  );
}

function SplitDiffView({ raw }: { raw: string }): React.JSX.Element {
  const sideBySideRows = parseSideBySideDiff(raw);
  return (
    <>
      <div className="sm:hidden">
        <TraditionalDiffView lines={parseUnifiedDiff(raw)} />
      </div>

      <div className="hidden sm:block">
        <div className="grid grid-cols-2 border-b border-border bg-muted/40 text-[11px] font-medium text-muted-foreground">
          <div className="border-r border-border px-3 py-2">Before</div>
          <div className="px-3 py-2">After</div>
        </div>
        {sideBySideRows.map((row, index) => {
          if (row.kind === "meta") {
            return (
              <div
                key={`meta-${index}`}
                className="border-b border-border/60 bg-muted/30 px-3 py-1.5 font-mono text-[11px] italic text-muted-foreground"
              >
                {row.content}
              </div>
            );
          }

          return (
            <div
              key={`pair-${index}`}
              className="grid grid-cols-2 border-b border-border/50"
            >
              <div
                className={`grid min-w-0 grid-cols-[3rem_1.5rem_minmax(0,1fr)] border-r border-border px-2 py-0.5 font-mono text-xs leading-5 ${LINE_STYLES[row.left.type]}`}
              >
                <span className="select-none pr-2 text-right text-[10px] text-muted-foreground/60">
                  {row.left.lineNumber ?? ""}
                </span>
                <span
                  className={`select-none text-center text-[10px] ${GUTTER_STYLES[row.left.type]}`}
                >
                  {GUTTER_CHAR[row.left.type]}
                </span>
                <span
                  className={`min-w-0 whitespace-pre-wrap break-all ${TEXT_STYLES[row.left.type]}`}
                >
                  {row.left.content}
                </span>
              </div>
              <div
                className={`grid min-w-0 grid-cols-[3rem_1.5rem_minmax(0,1fr)] px-2 py-0.5 font-mono text-xs leading-5 ${LINE_STYLES[row.right.type]}`}
              >
                <span className="select-none pr-2 text-right text-[10px] text-muted-foreground/60">
                  {row.right.lineNumber ?? ""}
                </span>
                <span
                  className={`select-none text-center text-[10px] ${GUTTER_STYLES[row.right.type]}`}
                >
                  {GUTTER_CHAR[row.right.type]}
                </span>
                <span
                  className={`min-w-0 whitespace-pre-wrap break-all ${TEXT_STYLES[row.right.type]}`}
                >
                  {row.right.content}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

function areDiffBlockPropsEqual(
  prev: DiffBlockProps,
  next: DiffBlockProps,
): boolean {
  return prev.changes === next.changes;
}

export const DiffBlock = memo(DiffBlockComponent, areDiffBlockPropsEqual);
