"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "next-auth/react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  LayoutDashboard,
  Users,
  Receipt,
  LogOut,
  Settings,
  Shield,
  Heart,
} from "lucide-react";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { LanguageSwitcher } from "@/components/layout/language-switcher";

function SponsorBanner() {
  return (
    <div className="shrink-0 px-3 pb-2">
      <div className="rounded-lg border border-pink-500/20 bg-gradient-to-br from-pink-500/10 via-rose-500/5 to-transparent p-3">
        <div className="flex items-center gap-2 mb-1.5">
          <Heart className="h-3.5 w-3.5 text-pink-500 shrink-0" />
          <span className="text-xs font-semibold text-foreground">Support ShareTab</span>
        </div>
        <p className="text-xs text-muted-foreground mb-2.5 leading-relaxed">
          ShareTab is free and open source. If it saves you time, consider sponsoring development.
        </p>
        <a
          href="https://github.com/sponsors/sw-carlos-cristobal"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center justify-center gap-1.5 w-full rounded-md bg-pink-500/15 hover:bg-pink-500/25 border border-pink-500/20 px-2.5 py-1.5 text-xs font-medium text-pink-600 dark:text-pink-400 transition-colors"
        >
          <Heart className="h-3 w-3" />
          Sponsor on GitHub
        </a>
      </div>
    </div>
  );
}

const navItems = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/groups", label: "Groups", icon: Users },
  { href: "/split", label: "Quick Split", icon: Receipt },
];

type SidebarUser = {
  id: string;
  name?: string | null;
  email?: string | null;
  image?: string | null;
};

export function AppSidebar({
  user,
  isAdmin,
}: {
  user: SidebarUser;
  isAdmin?: boolean;
}) {
  const pathname = usePathname();

  const initials = user.name
    ? user.name
        .split(" ")
        .map((n) => n[0])
        .join("")
        .toUpperCase()
        .slice(0, 2)
    : user.email?.[0]?.toUpperCase() ?? "?";

  return (
    <aside className="hidden w-64 shrink-0 border-r bg-gradient-to-b from-primary/[0.03] to-muted/40 lg:flex lg:flex-col lg:sticky lg:top-0 lg:h-dvh overflow-hidden">
      {/* Brand area */}
      <div className="flex h-14 items-center gap-2.5 px-5 border-b border-transparent bg-gradient-to-r from-primary/[0.06] via-transparent to-transparent [border-image:linear-gradient(to_right,var(--color-primary)/0.15,transparent)_1]">
        <Receipt className="h-6 w-6 text-primary drop-shadow-sm" />
        <span className="text-lg font-bold tracking-wide text-foreground">
          ShareTab
        </span>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto space-y-1 p-3">
        {navItems.map((item) => {
          const active =
            pathname === item.href || pathname.startsWith(item.href + "/");
          return (
            <Link key={item.href} href={item.href}>
              <span
                className={cn(
                  "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-all duration-200",
                  active
                    ? "border-l-[3px] border-primary bg-primary/10 text-primary shadow-sm"
                    : "border-l-[3px] border-transparent text-muted-foreground hover:bg-muted/80 hover:text-foreground hover:translate-x-0.5"
                )}
              >
                <item.icon className="h-5 w-5 shrink-0" />
                {item.label}
              </span>
            </Link>
          );
        })}
        {isAdmin && (
          <Link href="/admin">
            <span
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-all duration-200",
                pathname === "/admin"
                  ? "border-l-[3px] border-primary bg-primary/10 text-primary shadow-sm"
                  : "border-l-[3px] border-transparent text-muted-foreground hover:bg-muted/80 hover:text-foreground hover:translate-x-0.5"
              )}
            >
              <Shield className="h-5 w-5 shrink-0" />
              Admin
            </span>
          </Link>
        )}
      </nav>

      {/* Sponsor banner */}
      <SponsorBanner />

      {/* User profile section */}
      <div className="shrink-0 border-t border-transparent [border-image:linear-gradient(to_right,transparent,var(--color-border),transparent)_1] p-3">
        <div className="flex items-center gap-3 rounded-lg px-3 py-2">
          <Avatar className="h-8 w-8 ring-2 ring-primary/20">
            <AvatarImage src={user.image ?? undefined} />
            <AvatarFallback className="bg-primary/10 text-xs font-semibold text-primary">
              {initials}
            </AvatarFallback>
          </Avatar>
          <div className="flex-1 truncate">
            <p className="truncate text-sm font-medium">{user.name ?? "User"}</p>
            <p className="truncate text-xs text-muted-foreground">
              {user.email}
            </p>
          </div>
        </div>
        <div className="mt-2 flex items-center justify-between px-1">
          <div className="flex items-center gap-1">
            <Link
              href="/settings"
              className="inline-flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors duration-200 hover:bg-muted hover:text-foreground"
            >
              <Settings className="h-3.5 w-3.5" />
              Settings
            </Link>
            <Button
              variant="ghost"
              size="xs"
              className="gap-2 text-muted-foreground"
              onClick={() => signOut({ callbackUrl: "/login" })}
            >
              <LogOut className="h-3.5 w-3.5" />
              Sign out
            </Button>
          </div>
          <div className="flex items-center gap-1">
            <LanguageSwitcher />
            <ThemeToggle />
          </div>
        </div>
      </div>
    </aside>
  );
}
