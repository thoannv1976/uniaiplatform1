import {
  BadRequestException,
  Catch,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { DepartmentError, DirectoryError, QuotaError, RegistryError } from '@uniai/firestore';
import { CsvFormatError } from '@uniai/shared';
import type { Response } from 'express';

type DomainError = DepartmentError | DirectoryError | RegistryError | QuotaError | CsvFormatError;

/** Maps domain errors thrown by the stores to HTTP errors with their Vietnamese message. */
@Catch(DepartmentError, DirectoryError, RegistryError, QuotaError, CsvFormatError)
export class DomainErrorFilter extends BaseExceptionFilter implements ExceptionFilter {
  override catch(error: DomainError, host: ArgumentsHost) {
    let http: HttpException;
    if (error instanceof CsvFormatError) http = new BadRequestException(error.message);
    else if (error.code === 'quota_exceeded' || error.code === 'premium_exceeded') {
      // 402: out of quota (spec 5.2 step 7).
      http = new HttpException(error.message, HttpStatus.PAYMENT_REQUIRED);
    } else if (error.code === 'rate_limited') {
      if (error instanceof QuotaError && error.retryAfterSeconds) {
        host
          .switchToHttp()
          .getResponse<Response>()
          .setHeader('Retry-After', String(error.retryAfterSeconds));
      }
      http = new HttpException(error.message, HttpStatus.TOO_MANY_REQUESTS);
    } else if (error.code === 'not_found') http = new NotFoundException(error.message);
    else if (error.code === 'forbidden') http = new ForbiddenException(error.message);
    else if (error.code === 'conflict') http = new ConflictException(error.message);
    else http = new BadRequestException(error.message);
    super.catch(http, host);
  }
}
