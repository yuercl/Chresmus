import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ArrowUp, Loader2, Paperclip, X } from "lucide-react";
import type { UnifiedInputPart } from "@chresmus/unified-surface";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

type ComposerImageAttachment = {
  id: string;
  name: string;
  url: string;
};

type ChatComposerProps = {
  canSend: boolean;
  isBusy: boolean;
  isGenerating: boolean;
  placeholder?: string;
  onInterrupt: () => void | Promise<void>;
  onSend: (parts: UnifiedInputPart[]) => void | Promise<void>;
};

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => {
      reject(new Error(`Failed to read image: ${file.name}`));
    };
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error(`Failed to read image: ${file.name}`));
        return;
      }
      resolve(result);
    };
    reader.readAsDataURL(file);
  });
}

export function ChatComposer({
  canSend,
  isBusy,
  isGenerating,
  placeholder = "Message Codex…",
  onInterrupt,
  onSend,
}: ChatComposerProps): React.JSX.Element {
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<ComposerImageAttachment[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const resizeFrameRef = useRef<number | null>(null);
  const previousHeightRef = useRef(0);
  const fileInputId = useId();

  const resizeTextarea = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }

    const maxHeight = 200;
    textarea.style.height = "auto";
    const nextHeight = Math.min(textarea.scrollHeight, maxHeight);
    const currentHeight = previousHeightRef.current;

    if (currentHeight <= 0) {
      textarea.style.height = `${nextHeight}px`;
      previousHeightRef.current = nextHeight;
      return;
    }

    if (nextHeight === currentHeight) {
      textarea.style.height = `${nextHeight}px`;
      return;
    }

    textarea.style.height = `${currentHeight}px`;

    if (resizeFrameRef.current !== null) {
      window.cancelAnimationFrame(resizeFrameRef.current);
    }

    resizeFrameRef.current = window.requestAnimationFrame(() => {
      if (!textareaRef.current) {
        return;
      }
      textareaRef.current.style.height = `${nextHeight}px`;
      resizeFrameRef.current = null;
    });
    previousHeightRef.current = nextHeight;
  }, []);

  useEffect(() => {
    resizeTextarea();
  }, [draft, resizeTextarea]);

  useEffect(() => {
    return () => {
      if (resizeFrameRef.current !== null) {
        window.cancelAnimationFrame(resizeFrameRef.current);
      }
    };
  }, []);

  const sendDraft = useCallback(async () => {
    if (isGenerating) {
      await onInterrupt();
      return;
    }
    const text = draft.trim();
    const parts: UnifiedInputPart[] = [];
    if (text.length > 0) {
      parts.push({ type: "text", text });
    }
    for (const attachment of attachments) {
      parts.push({ type: "image", url: attachment.url });
    }
    if (parts.length === 0 || !canSend || isBusy) {
      return;
    }

    await onSend(parts);
    setDraft("");
    setAttachments([]);
    previousHeightRef.current = 0;
  }, [attachments, canSend, draft, isBusy, isGenerating, onInterrupt, onSend]);

  const disableSend = isGenerating
    ? !canSend || isBusy
    : !canSend || isBusy || (!draft.trim() && attachments.length === 0);
  const shouldSendOnEnter = useCallback(() => {
    if (typeof window.matchMedia !== "function") {
      return true;
    }
    return !window.matchMedia("(pointer: coarse)").matches;
  }, []);

  const attachImageFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) {
      return;
    }
    const nextAttachments = await Promise.all(
      files.map(async (file, index) => ({
        id: `${file.name}-${file.lastModified}-${String(index)}`,
        name: file.name,
        url: await readFileAsDataUrl(file),
      })),
    );
    setAttachments((current) => [...current, ...nextAttachments]);
  }, []);

  const handleAttachImages = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) {
      return;
    }
    const imageFiles = Array.from(files).filter((file) =>
      file.type.startsWith("image/"),
    );
    if (imageFiles.length === 0) {
      return;
    }
    await attachImageFiles(imageFiles);
  }, [attachImageFiles]);

  const removeAttachment = useCallback((attachmentId: string) => {
    setAttachments((current) =>
      current.filter((attachment) => attachment.id !== attachmentId),
    );
  }, []);

  return (
    <div className="rounded-[28px] border border-border bg-card pl-3 pr-2.5 py-2.5 focus-within:border-muted-foreground/40 transition-colors">
      {attachments.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2 pr-1">
          {attachments.map((attachment) => (
            <div
              key={attachment.id}
              className="group relative h-20 w-20 overflow-hidden rounded-2xl border border-border/70 bg-muted/30"
            >
              <img
                src={attachment.url}
                alt={attachment.name}
                className="h-full w-full object-cover"
                loading="lazy"
                decoding="async"
              />
              <button
                type="button"
                onClick={() => {
                  removeAttachment(attachment.id);
                }}
                className="absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-full bg-black/70 text-white opacity-90 transition group-hover:opacity-100"
                aria-label={`Remove ${attachment.name}`}
                title={`Remove ${attachment.name}`}
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-end gap-2">
        <input
          id={fileInputId}
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(event) => {
            void handleAttachImages(event.target.files);
            event.target.value = "";
          }}
        />
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-9 w-9 shrink-0 rounded-full text-muted-foreground hover:text-foreground"
          onClick={() => {
            fileInputRef.current?.click();
          }}
          disabled={!canSend || isBusy}
          title="Attach images"
          aria-label="Attach images"
        >
          <Paperclip size={14} />
        </Button>
        <Textarea
          ref={textareaRef}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            resizeTextarea();
          }}
          onKeyDown={(e) => {
            if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing &&
              shouldSendOnEnter()
            ) {
              e.preventDefault();
              void sendDraft();
            }
          }}
          onPaste={(event) => {
            const files = Array.from(event.clipboardData.files).filter((file) =>
              file.type.startsWith("image/"),
            );
            if (files.length === 0) {
              return;
            }
            event.preventDefault();
            void attachImageFiles(files);
          }}
          placeholder={placeholder}
          rows={1}
          className="flex-1 min-h-9 max-h-[200px] resize-none overflow-y-auto border-0 bg-transparent px-0 py-2 text-base leading-5 shadow-none transition-[height] duration-90 ease-out focus-visible:ring-0 md:text-sm"
        />
        <Button
          type="button"
          onClick={() => {
            void sendDraft();
          }}
          disabled={disableSend}
          title={isGenerating ? "Stop" : "Send"}
          aria-label={isGenerating ? "Stop" : "Send"}
          size="icon"
          className={`h-9 w-9 shrink-0 self-end rounded-full disabled:opacity-30 ${
            isGenerating
              ? "bg-white text-black hover:bg-white/90"
              : "bg-foreground text-background hover:bg-foreground/80"
          }`}
        >
          {isGenerating ? (
            <span className="block h-2.5 w-2.5 rounded-[2px] bg-current" />
          ) : isBusy ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <ArrowUp size={13} />
          )}
        </Button>
      </div>
    </div>
  );
}
