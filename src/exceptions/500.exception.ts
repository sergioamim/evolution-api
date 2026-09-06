import { HttpStatus } from '@api/routes/http-status';

export class InternalServerErrorException {
  constructor(...objectError: any[]) {
    throw {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      error: 'Internal Server Error',
      message: objectError.length > 0 ? objectError : undefined,
    };
  }
}
