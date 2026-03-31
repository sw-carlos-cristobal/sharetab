"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "next-auth/react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import {
  LayoutDashboard,
  Users,
  Receipt,
  LogOut,
  Settings,
  Menu,
} from "lucide-react";
import { ThemeToggle } from "@/components/layout/theme-toggle";

const navItems = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/groups", label: "Groups", icon: Users },
  { href: "/split", label: "Quick Split", icon: Receipt },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function MobileHeader() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  return (
    <header className="sticky top-0 z-50 flex h-14 items-center justify-between border-b border-border/60 bg-background/80 px-4 backdrop-blur-md supports-[backdrop-filter]:bg-background/60 lg:hidden">
      <div className="flex items-center gap-2.5">
        <Receipt className="h-5 w-5 text-primary drop-shadow-sm" />
        <span className="text-lg font-bold tracking-wide">ShareTab</span>
      </div>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger render={<Button variant="ghost" size="icon" />}>
          <Menu className="h-5 w-5" />
        </SheetTrigger>
        <SheetContent side="right" className="w-64">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2.5">
              <Receipt className="h-5 w-5 text-primary drop-shadow-sm" />
              <span className="tracking-wide">ShareTab</span>
            </SheetTitle>
          </SheetHeader>
          <nav className="mt-6 space-y-1">
            {navItems.map((item) => {
              const active =
                pathname === item.href ||
                pathname.startsWith(item.href + "/");
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setOpen(false)}
                >
                  <span
                    className={cn(
                      "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-all duration-200",
                      active
                        ? "border-l-[3px] border-primary bg-primary/10 text-primary shadow-sm"
                        : "border-l-[3px] border-transparent text-muted-foreground hover:bg-muted/80 hover:text-foreground"
                    )}
                  >
                    <item.icon className="h-5 w-5 shrink-0" />
                    {item.label}
                  </span>
                </Link>
              );
            })}
            <div className="mt-2 flex w-full items-center gap-2 rounded-lg px-3 py-2">
              <button
                onClick={() => {
                  setOpen(false);
                  signOut({ callbackUrl: "/login" });
                }}
                className="flex flex-1 items-center gap-3 text-sm font-medium text-muted-foreground transition-colors duration-200 hover:text-foreground"
              >
                <LogOut className="h-5 w-5" />
                Sign out
              </button>
              <ThemeToggle />
            </div>
          </nav>
        </SheetContent>
      </Sheet>
    </header>
  );
}
