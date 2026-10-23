import {
  SetMetadata,
  ValidationPipe,
  type ArgumentMetadata,
  type PipeTransform,
} from '@nestjs/common';
import type { ValidationError } from 'class-validator';
import { ApiError } from './api-error';

const VALIDATION_CODE = 'validation-code';

/** Names the `{ error }` code a request that fails this DTO's validation is answered with. */
export const ValidationCode = (code: string) =>
  SetMetadata(VALIDATION_CODE, code);

export function validationFailure(errors: ValidationError[]): ApiError {
  const target: unknown = errors[0]?.target;
  const code: unknown =
    typeof target === 'object' && target !== null
      ? Reflect.getMetadata(VALIDATION_CODE, target.constructor)
      : undefined;
  return new ApiError(400, typeof code === 'string' ? code : 'bad_request');
}

const pipeOptions = {
  transform: true,
  whitelist: true,
  validationError: { target: true },
  exceptionFactory: validationFailure,
};

/** Strips unknown query keys, and rejects unknown fields in a request body. */
export class RequestValidationPipe implements PipeTransform {
  private readonly lenient = new ValidationPipe(pipeOptions);
  private readonly strict = new ValidationPipe({
    ...pipeOptions,
    forbidNonWhitelisted: true,
  });

  transform(value: unknown, metadata: ArgumentMetadata): Promise<unknown> {
    return (metadata.type === 'body' ? this.strict : this.lenient).transform(
      value,
      metadata,
    );
  }
}
