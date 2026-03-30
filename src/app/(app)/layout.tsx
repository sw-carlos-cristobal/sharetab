import { redirect } from "next/navigation";
import { auth } from "@/server/auth";
import { AppSidebar } from "@/components/layout/sidebar";
import { MobileHeader } from "@/components/layout/mobile-header";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user) {
    redirect("/login");
  }

  return (
    <div className="flex min-h-screen flex-col lg:h-dvh lg:flex-row lg:overflow-hidden">
      <MobileHeader />
      <AppSidebar user={session.user} />
      <main className="flex-1 min-w-0 overflow-auto">
        <div className="mx-auto w-full max-w-5xl py-4 px-4 md:py-6 md:px-8">{children}</div>
      </main>
    </div>
  );
}
