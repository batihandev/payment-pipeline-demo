import { ConfigService } from '@nestjs/config';
import { logStartupFailure } from '@app/logging';
import { createApp } from './bootstrap';
import type { ApiConfig } from './common/api-config';

async function bootstrap(): Promise<void> {
  const app = await createApp();
  app.enableShutdownHooks();
  const config = app.get<ConfigService<ApiConfig, true>>(ConfigService);
  await app.listen(
    config.get('API_PORT', { infer: true }),
    config.get('API_HOST', { infer: true }),
  );
}

bootstrap().catch((error: unknown) => {
  logStartupFailure(error);
  process.exitCode = 1;
});
