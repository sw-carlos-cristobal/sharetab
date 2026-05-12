import { Loader2 } from "lucide-react";

export function LoadingSpinner({ text }: { text?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-12 text-muted-foreground">
      <Loader2 className="h-5 w-5 animate-spin" />
      {text && <span>{text}</span>}
    </div>
  );
}
