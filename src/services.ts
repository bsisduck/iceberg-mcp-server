import type { AppConfig } from './config.js';
import { ApiService } from './api/api-service.js';
import { JavadocProvider } from './api/javadoc-provider.js';
import { SourceProvider } from './api/source-provider.js';

export interface Services {
  readonly api: ApiService;
  close(): Promise<void>;
}

export async function createServices(config: AppConfig): Promise<Services> {
  const javadoc = new JavadocProvider({
    config: config.javadoc,
    requestTimeoutMs: config.limits.requestTimeoutMs,
  });
  const source =
    config.sourceDir === undefined ? undefined : await SourceProvider.create(config.sourceDir);
  const api = new ApiService({ config, javadoc, source });
  return {
    api,
    close(): Promise<void> {
      javadoc.clear();
      source?.clear();
      return Promise.resolve();
    },
  };
}
