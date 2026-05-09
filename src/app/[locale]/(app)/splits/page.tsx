"use client";

import { Link } from "@/i18n/navigation";
import { trpc } from "@/lib/trpc";
import { formatCents } from "@/lib/money";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Scissors, Receipt, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useTranslations, useLocale } from "next-intl";

export default function SplitsPage() {
  const t = useTranslations("splits");
  const locale = useLocale();

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading } =
    trpc.guest.mySplits.useInfiniteQuery(
      { limit: 20 },
      {
        getNextPageParam: (lastPage) => lastPage.nextCursor,
        initialCursor: undefined,
      },
    );

  const utils = trpc.useUtils();
  const deleteSplit = trpc.guest.deleteSplit.useMutation({
    onSuccess: () => {
      utils.guest.mySplits.invalidate();
      toast.success(t("deleted"));
    },
  });

  const splits = data?.pages.flatMap((page) => page.splits) ?? [];

  return (
    <div className="space-y-6" data-testid="splits-page">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{t("title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("description")}
          </p>
        </div>
        <Button nativeButton={false} render={<Link href="/split" />}>
          <Receipt className="mr-2 h-4 w-4" />
          {t("goToSplit")}
        </Button>
      </div>

      {isLoading && <p className="text-muted-foreground">{t("loading")}</p>}

      {!isLoading && splits.length === 0 && (
        <Card data-testid="splits-empty">
          <CardContent className="py-12 text-center">
            <Scissors className="mx-auto h-10 w-10 text-muted-foreground/50" />
            <p className="mt-3 text-muted-foreground">{t("empty")}</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("emptyDescription")}
            </p>
            <Button
              nativeButton={false}
              className="mt-4"
              render={<Link href="/split" />}
            >
              <Receipt className="mr-2 h-4 w-4" />
              {t("goToSplit")}
            </Button>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 grid-cols-[repeat(auto-fit,minmax(280px,1fr))]">
        {splits.map((split) => (
          <Card key={split.id} className="relative border-l-[3px] border-l-primary/60 transition-all duration-200 hover:-translate-y-px hover:border-l-primary hover:shadow-md" data-testid={`split-card-${split.id}`}>
            <Link
              href={
                split.status === "finalized"
                  ? `/split/${split.shareToken}`
                  : `/split/${split.shareToken}/claim`
              }
              className="block"
            >
              <CardHeader className="pb-2 pr-10">
                <CardTitle className="flex items-center gap-2.5 text-base">
                  <Scissors className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="flex-1 truncate">
                    {split.merchantName ?? t("untitled")}
                  </span>
                  <Badge
                    variant={
                      split.status === "finalized" ? "default" : "outline"
                    }
                    className="shrink-0 text-[10px]"
                  >
                    {split.status === "finalized"
                      ? t("finalized")
                      : t("claiming")}
                  </Badge>
                </CardTitle>
              </CardHeader>
              <CardContent>
                {split.total != null && (
                  <p className="mb-1.5 text-lg font-semibold">
                    {formatCents(split.total, split.currency, locale)}
                  </p>
                )}
                <div className="flex items-center justify-between text-sm text-muted-foreground">
                  <span>
                    {t("people", { count: split.peopleCount })}
                    {" · "}
                    {t("items", { count: split.itemCount })}
                  </span>
                  <span>
                    {new Date(split.createdAt).toLocaleDateString(locale)}
                  </span>
                </div>
              </CardContent>
            </Link>
            <button
              type="button"
              onClick={() => {
                if (confirm(t("deleteConfirm"))) {
                  deleteSplit.mutate({ id: split.id });
                }
              }}
              className="absolute top-3 right-3 rounded-md p-1.5 text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
              aria-label={t("delete")}
              data-testid={`delete-split-${split.id}`}
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </Card>
        ))}
      </div>

      {hasNextPage && (
        <div className="text-center">
          <Button
            variant="outline"
            size="sm"
            onClick={() => fetchNextPage()}
            disabled={isFetchingNextPage}
          >
            {t("loadMore")}
          </Button>
        </div>
      )}
    </div>
  );
}
