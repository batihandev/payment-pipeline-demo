import { Global, Inject, Module } from '@nestjs/common';

export type Now = () => Date;
export const NOW = Symbol('NOW');
export const InjectNow = () => Inject(NOW);

@Global()
@Module({
  providers: [{ provide: NOW, useValue: ((): Date => new Date()) as Now }],
  exports: [NOW],
})
export class ClockModule {}
