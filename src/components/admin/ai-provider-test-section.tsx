'use client';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
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
const KNOWN_PROVIDERS = new Set(['openai', 'openai-codex', 'claude', 'meridian', 'ollama', 'ocr']);

export function AIProviderTestSection() {
  const t = useTranslations("admin");
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

  const nonOAuthProviders = allProviders.filter(
    (p) => KNOWN_PROVIDERS.has(p) && !OAUTH_PROVIDERS.has(p)
  );

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0];
    if (!selected) return;
    if (!ACCEPTED_TYPES.includes(selected.type)) return;
    if (selected.size > 5 * 1024 * 1024) return;

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
          <h2 className="text-lg font-semibold">{t("aiProviderTest.title")}</h2>
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
    <section data-testid="ai-provider-test-section">
      <div className="mb-4 flex items-center gap-2">
        <FlaskConical className="h-5 w-5 text-muted-foreground" />
        <h2 className="text-lg font-semibold">{t("aiProviderTest.title")}</h2>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            {t("aiProviderTest.description")}
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
              data-testid="ai-test-file-input"
            />
            <Button
              size="sm"
              variant="outline"
              onClick={() => fileRef.current?.click()}
              data-testid="ai-test-upload-btn"
            >
              <Upload className="mr-2 h-4 w-4" />
              {file ? t("aiProviderTest.changeImage") : t("aiProviderTest.uploadImage")}
            </Button>
            {file && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="ai-test-file-info">
                <span className="max-w-48 truncate">{file.name}</span>
                <button type="button" onClick={clearFile} className="text-muted-foreground hover:text-foreground" data-testid="ai-test-clear-btn" aria-label={t("aiProviderTest.clearFile")}>
                  <X className="h-4 w-4" />
                </button>
              </div>
            )}
          </div>

          <div className="flex flex-wrap gap-2" data-testid="ai-test-provider-buttons">
            {nonOAuthProviders.map((name) => (
              <Button
                key={name}
                size="sm"
                variant="outline"
                disabled={!file || testProvider.isPending}
                onClick={() => handleTest(name)}
                data-testid={`ai-test-btn-${name}`}
              >
                {testProvider.isPending && activeProvider === name ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <FlaskConical className="mr-2 h-4 w-4" />
                )}
                {t("aiProviderTest.testProvider", { name })}
              </Button>
            ))}
          </div>

          {!file && (
            <p className="text-sm text-muted-foreground" data-testid="ai-test-upload-hint">
              {t("aiProviderTest.uploadHint")}
            </p>
          )}

          {testProvider.isSuccess && (
            <div className="space-y-2" data-testid="ai-test-success">
              <p className="flex items-center gap-1 text-sm text-green-600" data-testid="ai-test-success-msg">
                <CheckCircle2 className="h-4 w-4" />
                {t("aiProviderTest.success", { provider: activeProvider, duration: testProvider.data.durationMs })}
              </p>
              <pre className="max-h-96 overflow-auto rounded-md bg-muted p-3 text-xs" data-testid="ai-test-result-json">
                {JSON.stringify(testProvider.data.result, null, 2)}
              </pre>
            </div>
          )}

          {testProvider.isError && (
            <div className="space-y-2" data-testid="ai-test-error">
              <p className="flex items-center gap-1 text-sm text-destructive" data-testid="ai-test-error-msg">
                <AlertCircle className="h-4 w-4" />
                {t("aiProviderTest.failed", { provider: activeProvider, error: testProvider.error.message })}
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
