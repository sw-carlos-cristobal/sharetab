import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

export function LoadingSpinner({ text, className }: { text?: string; className?: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn("flex items-center justify-center gap-2 py-12 text-muted-foreground", className)}
    >
      <Loader2 className="h-5 w-5 animate-spin" />
      {text ? <span>{text}</span> : <span className="sr-only">Loading</span>}
    </div>
  );
}
