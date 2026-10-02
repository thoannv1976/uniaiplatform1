import {
  BadRequestException,
  Catch,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  type ArgumentsHost,
  type ExceptionFilter,
  type HttpException,
} from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { DepartmentError, DirectoryError, RegistryError } from '@uniai/firestore';
import { CsvFormatError } from '@uniai/shared';

/** Maps domain errors thrown by the stores to HTTP errors with their Vietnamese message. */
@Catch(DepartmentError, DirectoryError, RegistryError, CsvFormatError)
export class DomainErrorFilter extends BaseExceptionFilter implements ExceptionFilter {
  override catch(
    error: DepartmentError | DirectoryError | RegistryError | CsvFormatError,
    host: ArgumentsHost,
  ) {
    let http: HttpException;
    if (error instanceof CsvFormatError) http = new BadRequestException(error.message);
    else if (error.code === 'not_found') http = new NotFoundException(error.message);
    else if (error.code === 'forbidden') http = new ForbiddenException(error.message);
    else if (error.code === 'conflict') http = new ConflictException(error.message);
    else http = new BadRequestException(error.message);
    super.catch(http, host);
  }
}
