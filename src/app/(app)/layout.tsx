import { redirect } from "next/navigation";
import { auth } from "@/server/auth";
import { AppSidebar } from "@/components/layout/sidebar";
import { MobileHeader } from "@/components/layout/mobile-header";
import { AnnouncementBanner } from "@/components/layout/announcement-banner";
import { ImpersonationBanner } from "@/components/layout/impersonation-banner";
import { BugLensWidget } from "@/components/buglens";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user) {
    redirect("/login");
  }

  const isAdmin =
    !!process.env.ADMIN_EMAIL &&
    session.user.email === process.env.ADMIN_EMAIL;

  return (
    <div className="min-h-dvh lg:flex lg:h-dvh lg:flex-row">
      <MobileHeader isAdmin={isAdmin} />
      <AppSidebar user={session.user} isAdmin={isAdmin} />
      <main className="@container flex-1 min-w-0 lg:overflow-auto">
        <ImpersonationBanner />
        <AnnouncementBanner />
        <div className="w-full py-4 px-4 md:py-6 md:px-8 2xl:mx-auto 2xl:max-w-5xl">{children}</div>
      </main>
      <BugLensWidget />
    </div>
  );
}
