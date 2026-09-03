import type { AppConfig } from './config.js';
import { ApiService } from './api/api-service.js';
import { JavadocProvider } from './api/javadoc-provider.js';
import { SourceProvider } from './api/source-provider.js';
import { CatalogClient } from './catalog/client.js';
import { createStderrReporter } from './shared/logging.js';

export interface Services {
  readonly api: ApiService;
  readonly catalog: CatalogClient | undefined;
  close(): Promise<void>;
}

export async function createServices(config: AppConfig): Promise<Services> {
  const javadoc = new JavadocProvider({
    config: config.javadoc,
    reporter: createStderrReporter(config.logLevel),
    requestTimeoutMs: config.limits.requestTimeoutMs,
  });
  const source =
    config.sourceDir === undefined
      ? undefined
      : await SourceProvider.create(config.sourceDir, {
          indexMaxBytes: config.sourceIndexMaxBytes,
        });
  const api = new ApiService({ config, javadoc, source });
  const catalog =
    config.catalog.uri === undefined
      ? undefined
      : await CatalogClient.create({
          config: config.catalog,
          limits: config.limits,
          logLevel: config.logLevel,
        });
  return {
    api,
    catalog,
    close(): Promise<void> {
      catalog?.close();
      javadoc.clear();
      source?.clear();
      return Promise.resolve();
    },
  };
}
