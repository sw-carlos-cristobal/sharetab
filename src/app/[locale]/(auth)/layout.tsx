import { LanguageSwitcher } from "@/components/layout/language-switcher";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative flex min-h-screen items-center justify-center bg-muted/50 p-4 overflow-hidden">
      {/* Language switcher - top right */}
      <div className="absolute top-4 right-4 z-10">
        <LanguageSwitcher />
      </div>

      {/* Radial gradient glow behind the card */}
      <div
        className="pointer-events-none absolute inset-0"
        aria-hidden="true"
        style={{
          background:
            "radial-gradient(ellipse 60% 50% at 50% 40%, var(--primary) 0%, transparent 70%)",
          opacity: 0.07,
        }}
      />
      <div className="relative w-full max-w-md">{children}</div>
    </div>
  );
}
