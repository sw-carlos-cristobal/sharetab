import { Link } from "@/i18n/navigation";
import { Receipt } from "lucide-react";
import { auth } from "@/server/auth";

export default async function SplitLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();

  return (
    <div className="min-h-[100dvh] flex flex-col bg-background">
      {/* Minimal header */}
      <header className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="mx-auto flex h-14 max-w-lg items-center justify-between px-4">
          <Link href="/split" className="flex items-center gap-2 font-bold text-lg">
            <Receipt className="h-5 w-5 text-primary" />
            <span>ShareTab</span>
          </Link>
          {session?.user ? (
            <Link
              href="/dashboard"
              className="text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              Dashboard
            </Link>
          ) : (
            <Link
              href="/login"
              className="text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              Sign in
            </Link>
          )}
        </div>
      </header>

      {/* Content */}
      <main className="flex-1 mx-auto w-full max-w-lg px-4 py-6">
        {children}
      </main>
    </div>
  );
}
