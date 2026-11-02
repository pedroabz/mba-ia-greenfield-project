export abstract class DomainException extends Error {
  constructor(
    public readonly errorCode: string,
    public readonly httpStatus: number,
    message: string,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class EmailAlreadyExistsException extends DomainException {
  constructor() {
    super('EMAIL_ALREADY_EXISTS', 409, 'Email is already registered');
  }
}

export class InvalidCredentialsException extends DomainException {
  constructor() {
    super('INVALID_CREDENTIALS', 401, 'Invalid email or password');
  }
}

export class EmailNotConfirmedException extends DomainException {
  constructor() {
    super('EMAIL_NOT_CONFIRMED', 403, 'Email address has not been confirmed');
  }
}

export class InvalidTokenException extends DomainException {
  constructor() {
    super('INVALID_TOKEN', 401, 'Token is invalid');
  }
}

export class TokenExpiredException extends DomainException {
  constructor() {
    super('TOKEN_EXPIRED', 401, 'Token has expired');
  }
}

export class TokenReuseDetectedException extends DomainException {
  constructor() {
    super(
      'TOKEN_REUSE_DETECTED',
      401,
      'Token reuse detected — all sessions revoked',
    );
  }
}

// --- videos (phase-03-videos § Error Catalog) ---

export class VideoNotFoundException extends DomainException {
  constructor() {
    super('VIDEO_NOT_FOUND', 404, 'Video not found');
  }
}

export class VideoNotOwnedException extends DomainException {
  constructor() {
    super(
      'VIDEO_NOT_OWNED',
      403,
      'Authenticated user does not own the channel this video belongs to',
    );
  }
}

export class VideoInvalidStateException extends DomainException {
  constructor(current: string) {
    super(
      'VIDEO_INVALID_STATE',
      409,
      `Operation is not valid while the video is in status "${current}"`,
    );
  }
}

export class VideoNotReadyException extends DomainException {
  constructor() {
    super('VIDEO_NOT_READY', 409, 'Video processing has not finished yet');
  }
}

/**
 * Blocks the signing endpoint from being used as an open oracle: without this the
 * caller could have any key in the bucket signed.
 */
export class UploadKeyMismatchException extends DomainException {
  constructor() {
    super(
      'UPLOAD_KEY_MISMATCH',
      403,
      'Key does not match the key recorded on this draft',
    );
  }
}

export class UploadObjectMissingException extends DomainException {
  constructor() {
    super('UPLOAD_OBJECT_MISSING', 409, 'No object stored at the draft key');
  }
}

export class UploadSizeMismatchException extends DomainException {
  constructor(declared: string, observed: number) {
    super(
      'UPLOAD_SIZE_MISMATCH',
      409,
      `Stored object is ${observed} bytes but ${declared} were declared — the upload is truncated or was completed incorrectly`,
    );
  }
}

export class RangeNotSatisfiableException extends DomainException {
  constructor() {
    super(
      'RANGE_NOT_SATISFIABLE',
      416,
      'Requested range is outside the object',
    );
  }
}
