import { Global, Module, type DynamicModule } from '@nestjs/common';

export const QUEUE_ERROR_MESSAGE = Symbol('QUEUE_ERROR_MESSAGE');

/** Provides the line that queues log when their connection fails, to every module. */
@Global()
@Module({})
export class QueueErrorsModule {
  static forRoot(options: { message: string }): DynamicModule {
    return {
      module: QueueErrorsModule,
      providers: [{ provide: QUEUE_ERROR_MESSAGE, useValue: options.message }],
      exports: [QUEUE_ERROR_MESSAGE],
    };
  }
}
