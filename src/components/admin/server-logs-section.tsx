"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  ScrollText,
  Loader2,
  Pause,
  Play,
  ArrowDown,
  Search,
} from "lucide-react";

const LEVEL_COLORS: Record<string, string> = {
  debug: "text-muted-foreground",
  info: "text-blue-600 dark:text-blue-400",
  warn: "text-yellow-600 dark:text-yellow-400",
  error: "text-red-600 dark:text-red-400",
};

const LEVEL_BG: Record<string, string> = {
  debug: "bg-muted",
  info: "bg-blue-100 dark:bg-blue-950 text-blue-700 dark:text-blue-300",
  warn: "bg-yellow-100 dark:bg-yellow-950 text-yellow-700 dark:text-yellow-300",
  error: "bg-red-100 dark:bg-red-950 text-red-700 dark:text-red-300",
};

type LogLevel = "debug" | "info" | "warn" | "error";

export function ServerLogsSection() {
  const [minLevel, setMinLevel] = useState<LogLevel>("debug");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [paused, setPaused] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const logs = trpc.admin.getLogs.useQuery(
    {
      minLevel,
      search: debouncedSearch || undefined,
      limit: 200,
    },
    {
      refetchInterval: paused ? false : 2000,
    }
  );

  // Auto-scroll to bottom when new logs arrive
  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs.data?.entries.length, autoScroll]);

  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    // If user scrolled up more than 50px from bottom, disable auto-scroll
    const isAtBottom = scrollHeight - scrollTop - clientHeight < 50;
    setAutoScroll(isAtBottom);
  }, []);

  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      setAutoScroll(true);
    }
  }, []);

  const levels: LogLevel[] = ["debug", "info", "warn", "error"];

  return (
    <section>
      <div className="mb-4 flex items-center gap-2">
        <ScrollText className="h-5 w-5 text-muted-foreground" />
        <h2 className="text-lg font-semibold">Server Logs</h2>
        {logs.data && (
          <Badge variant="secondary">
            {logs.data.entries.length} entries
          </Badge>
        )}
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex flex-wrap items-center gap-2">
            {/* Level filter buttons */}
            <div className="flex gap-1">
              {levels.map((level) => (
                <Button
                  key={level}
                  size="sm"
                  variant={minLevel === level ? "default" : "outline"}
                  onClick={() => setMinLevel(level)}
                  className="h-7 px-2.5 text-xs capitalize"
                >
                  {level}
                </Button>
              ))}
            </div>

            {/* Search */}
            <div className="relative flex-1 min-w-[180px]">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Filter logs..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-7 pl-8 text-xs"
              />
            </div>

            {/* Controls */}
            <div className="flex gap-1">
              <Button
                size="sm"
                variant="outline"
                onClick={() => setPaused(!paused)}
                className="h-7 px-2.5"
                title={paused ? "Resume auto-refresh" : "Pause auto-refresh"}
              >
                {paused ? (
                  <Play className="h-3.5 w-3.5" />
                ) : (
                  <Pause className="h-3.5 w-3.5" />
                )}
              </Button>
              {!autoScroll && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={scrollToBottom}
                  className="h-7 px-2.5"
                  title="Scroll to bottom"
                >
                  <ArrowDown className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {logs.isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div
              ref={scrollRef}
              onScroll={handleScroll}
              className="h-[400px] overflow-y-auto font-mono text-xs"
            >
              {logs.data?.entries.length === 0 ? (
                <div className="flex items-center justify-center py-12 text-muted-foreground">
                  No log entries found
                </div>
              ) : (
                <table className="w-full">
                  <tbody>
                    {logs.data?.entries.map((entry) => (
                      <tr
                        key={entry.id}
                        className="border-b border-border/50 hover:bg-muted/50"
                      >
                        <td className="whitespace-nowrap px-3 py-1.5 text-muted-foreground">
                          {formatTime(entry.ts)}
                        </td>
                        <td className="px-2 py-1.5">
                          <span
                            className={`inline-block w-14 rounded px-1.5 py-0.5 text-center text-[10px] font-semibold uppercase ${LEVEL_BG[entry.level]}`}
                          >
                            {entry.level}
                          </span>
                        </td>
                        <td
                          className={`px-3 py-1.5 ${LEVEL_COLORS[entry.level]}`}
                        >
                          <span className="font-medium">{entry.msg}</span>
                          {entry.data && Object.keys(entry.data).length > 0 && (
                            <span className="ml-2 text-muted-foreground">
                              {formatData(entry.data)}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
          {paused && (
            <div className="border-t bg-yellow-50 px-3 py-1.5 text-center text-xs text-yellow-700 dark:bg-yellow-950 dark:text-yellow-300">
              Auto-refresh paused
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

function formatTime(isoString: string): string {
  const d = new Date(isoString);
  return d.toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatData(data: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      parts.push(`${key}=${value}`);
    } else if (value !== null && value !== undefined) {
      parts.push(`${key}=${JSON.stringify(value)}`);
    }
  }
  return parts.join(" ");
}
