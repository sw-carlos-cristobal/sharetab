"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Receipt, Mail } from "lucide-react";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [magicLinkEmail, setMagicLinkEmail] = useState("");
  const [magicLinkSending, setMagicLinkSending] = useState(false);
  const [showMagicLink, setShowMagicLink] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    const result = await signIn("credentials", {
      email,
      password,
      redirect: false,
    });

    setLoading(false);

    if (result?.error) {
      setError("Invalid email or password");
    } else {
      router.push("/dashboard");
      router.refresh();
    }
  }

  async function handleMagicLink(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setMagicLinkSending(true);

    const result = await signIn("nodemailer", {
      email: magicLinkEmail,
      redirect: false,
      callbackUrl: "/dashboard",
    });

    setMagicLinkSending(false);

    if (result?.error) {
      setError("Could not send magic link. Is email configured?");
    } else {
      router.push("/verify-request");
    }
  }

  return (
    <Card className="border-primary/10 shadow-lg shadow-primary/5">
      <CardHeader className="text-center pb-2">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 ring-1 ring-primary/20">
          <Receipt className="h-7 w-7 text-primary" />
        </div>
        <CardTitle className="text-2xl font-semibold tracking-tight">Welcome back</CardTitle>
        <CardDescription className="mt-1">Sign in to your ShareTab account</CardDescription>
      </CardHeader>
      <CardContent className="pt-4">
        {!showMagicLink ? (
          <>
            <form onSubmit={handleSubmit} className="space-y-4">
              {error && (
                <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                  {error}
                </div>
              )}
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={6}
                />
              </div>
              <Button type="submit" className="w-full rounded-full h-10 text-sm font-medium mt-2" disabled={loading}>
                {loading ? "Signing in..." : "Sign in"}
              </Button>
            </form>

            <div className="relative my-8">
              <Separator />
              <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-card px-3 text-xs text-muted-foreground uppercase tracking-wider">
                or
              </span>
            </div>

            <Button
              variant="outline"
              className="w-full rounded-full h-10 text-sm border-primary/20 text-muted-foreground hover:text-foreground hover:border-primary/40"
              onClick={() => setShowMagicLink(true)}
            >
              <Mail className="mr-2 h-4 w-4" />
              Sign in with email link
            </Button>
          </>
        ) : (
          <>
            <form onSubmit={handleMagicLink} className="space-y-4">
              {error && (
                <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                  {error}
                </div>
              )}
              <p className="text-sm text-muted-foreground">
                We&apos;ll send you a magic link to sign in without a password.
              </p>
              <div className="space-y-2">
                <Label htmlFor="magic-email">Email</Label>
                <Input
                  id="magic-email"
                  type="email"
                  placeholder="you@example.com"
                  value={magicLinkEmail}
                  onChange={(e) => setMagicLinkEmail(e.target.value)}
                  required
                />
              </div>
              <Button type="submit" className="w-full rounded-full h-10 text-sm font-medium mt-2" disabled={magicLinkSending}>
                <Mail className="mr-2 h-4 w-4" />
                {magicLinkSending ? "Sending..." : "Send magic link"}
              </Button>
            </form>

            <div className="relative my-8">
              <Separator />
              <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-card px-3 text-xs text-muted-foreground uppercase tracking-wider">
                or
              </span>
            </div>

            <Button
              variant="outline"
              className="w-full rounded-full h-10 text-sm border-primary/20 text-muted-foreground hover:text-foreground hover:border-primary/40"
              onClick={() => setShowMagicLink(false)}
            >
              Sign in with password
            </Button>
          </>
        )}

        <div className="relative my-8">
          <Separator />
        </div>

        <div className="text-center space-y-3">
          <p className="text-sm text-muted-foreground">
            Don&apos;t have an account?{" "}
            <Link href="/register" className="font-medium text-primary hover:underline">
              Create one
            </Link>
          </p>
          <p className="text-xs text-muted-foreground/80">
            Just need to split a bill?{" "}
            <Link href="/split" className="font-medium text-primary hover:underline">
              Split without an account
            </Link>
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
