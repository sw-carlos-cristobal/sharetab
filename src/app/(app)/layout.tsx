import { redirect } from "next/navigation";
import { auth } from "@/server/auth";
import { AppSidebar } from "@/components/layout/sidebar";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user) {
    redirect("/login");
  }

  return (
    <div className="flex min-h-screen">
      <AppSidebar user={session.user} />
      <main className="flex-1 overflow-auto">
        <div className="container max-w-5xl py-6 px-4 md:px-8">{children}</div>
      </main>
    </div>
  );
}
