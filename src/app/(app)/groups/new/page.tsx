"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { trpc } from "@/lib/trpc";

const CURRENCY_OPTIONS = ["USD", "EUR", "GBP", "CAD", "AUD", "JPY", "INR", "BRL"];
const EMOJI_OPTIONS = ["💰", "🏠", "✈️", "🍽️", "🎉", "🛒", "🚗", "💼"];

export default function NewGroupPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [emoji, setEmoji] = useState("💰");

  const createGroup = trpc.groups.create.useMutation({
    onSuccess: (group) => {
      router.push(`/groups/${group.id}`);
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    createGroup.mutate({
      name,
      description: description || undefined,
      currency,
      emoji,
    });
  }

  return (
    <div className="mx-auto max-w-lg">
      <h1 className="mb-6 text-2xl font-bold">Create a new group</h1>
      <Card>
        <CardHeader>
          <CardTitle>Group details</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">Group name</Label>
              <Input
                id="name"
                placeholder="e.g., Apartment, Trip to Japan"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                maxLength={100}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="description">Description (optional)</Label>
              <Input
                id="description"
                placeholder="What is this group for?"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={500}
              />
            </div>

            <div className="space-y-2">
              <Label>Icon</Label>
              <div className="flex flex-wrap gap-2">
                {EMOJI_OPTIONS.map((e) => (
                  <button
                    key={e}
                    type="button"
                    onClick={() => setEmoji(e)}
                    className={`flex h-10 w-10 items-center justify-center rounded-md border text-lg transition-colors ${
                      emoji === e
                        ? "border-primary bg-primary/10"
                        : "border-border hover:bg-muted"
                    }`}
                  >
                    {e}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="currency">Currency</Label>
              <select
                id="currency"
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                {CURRENCY_OPTIONS.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>

            {createGroup.error && (
              <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                {createGroup.error.message}
              </div>
            )}

            <Button type="submit" className="w-full" disabled={createGroup.isPending}>
              {createGroup.isPending ? "Creating..." : "Create Group"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
