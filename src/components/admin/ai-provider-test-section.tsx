'use client';

import { useRef, useState } from 'react';
import { trpc } from '@/lib/trpc';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Loader2,
  FlaskConical,
  Upload,
  CheckCircle2,
  AlertCircle,
  X,
} from 'lucide-react';

const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const OAUTH_PROVIDERS = new Set(['meridian', 'openai-codex']);

export function AIProviderTestSection() {
  const health = trpc.admin.getSystemHealth.useQuery();
  const utils = trpc.useUtils();
  const testProvider = trpc.admin.testAIProvider.useMutation({
    onSettled: () => utils.admin.getAuditLog.invalidate(),
  });
  const fileRef = useRef<HTMLInputElement>(null);

  const [file, setFile] = useState<{ name: string; base64: string; mimeType: string } | null>(null);
  const [activeProvider, setActiveProvider] = useState<string | null>(null);

  const allProviders = health.data?.aiProvider
    ?.split(' -> ')
    .filter(Boolean) ?? [];

  const nonOAuthProviders = allProviders.filter((p) => !OAUTH_PROVIDERS.has(p));

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0];
    if (!selected) return;

    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.split(',')[1];
      setFile({ name: selected.name, base64, mimeType: selected.type });
      testProvider.reset();
    };
    reader.readAsDataURL(selected);
  };

  const clearFile = () => {
    setFile(null);
    testProvider.reset();
    setActiveProvider(null);
    if (fileRef.current) fileRef.current.value = '';
  };

  const handleTest = (providerName: string) => {
    if (!file) return;
    setActiveProvider(providerName);
    testProvider.mutate({
      providerName,
      imageBase64: file.base64,
      mimeType: file.mimeType as "image/jpeg" | "image/png" | "image/webp" | "image/gif",
    });
  };

  if (health.isLoading) {
    return (
      <section>
        <div className="mb-4 flex items-center gap-2">
          <FlaskConical className="h-5 w-5 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Other Provider Tests</h2>
        </div>
        <Card>
          <CardContent className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </CardContent>
        </Card>
      </section>
    );
  }

  if (nonOAuthProviders.length === 0) {
    return null;
  }

  return (
    <section>
      <div className="mb-4 flex items-center gap-2">
        <FlaskConical className="h-5 w-5 text-muted-foreground" />
        <h2 className="text-lg font-semibold">Other Provider Tests</h2>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Test receipt extraction against non-OAuth providers
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-3">
            <input
              ref={fileRef}
              type="file"
              accept={ACCEPTED_TYPES.join(',')}
              onChange={handleFileChange}
              className="hidden"
            />
            <Button
              size="sm"
              variant="outline"
              onClick={() => fileRef.current?.click()}
            >
              <Upload className="mr-2 h-4 w-4" />
              {file ? 'Change Image' : 'Upload Receipt Image'}
            </Button>
            {file && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <span className="max-w-48 truncate">{file.name}</span>
                <button onClick={clearFile} className="text-muted-foreground hover:text-foreground">
                  <X className="h-4 w-4" />
                </button>
              </div>
            )}
          </div>

          <div className="flex flex-wrap gap-2">
            {nonOAuthProviders.map((name) => (
              <Button
                key={name}
                size="sm"
                variant="outline"
                disabled={!file || testProvider.isPending}
                onClick={() => handleTest(name)}
              >
                {testProvider.isPending && activeProvider === name ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <FlaskConical className="mr-2 h-4 w-4" />
                )}
                Test {name}
              </Button>
            ))}
          </div>

          {!file && (
            <p className="text-sm text-muted-foreground">
              Upload a receipt image to enable testing.
            </p>
          )}

          {testProvider.isSuccess && (
            <div className="space-y-2">
              <p className="flex items-center gap-1 text-sm text-green-600">
                <CheckCircle2 className="h-4 w-4" />
                {activeProvider} responded in {testProvider.data.durationMs}ms
              </p>
              <pre className="max-h-96 overflow-auto rounded-md bg-muted p-3 text-xs">
                {JSON.stringify(testProvider.data.result, null, 2)}
              </pre>
            </div>
          )}

          {testProvider.isError && (
            <div className="space-y-2">
              <p className="flex items-center gap-1 text-sm text-destructive">
                <AlertCircle className="h-4 w-4" />
                {activeProvider} failed: {testProvider.error.message}
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
