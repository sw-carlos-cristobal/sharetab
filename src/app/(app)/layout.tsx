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
    <div className="min-h-dvh lg:flex lg:h-dvh lg:flex-row">
      <MobileHeader />
      <AppSidebar user={session.user} />
      <main className="@container flex-1 min-w-0 lg:overflow-auto">
        <div className="w-full py-4 px-4 md:py-6 md:px-8 2xl:mx-auto 2xl:max-w-5xl">{children}</div>
      </main>
    </div>
  );
}
