import { getAuth } from 'firebase-admin/auth';
import { getAdminApp } from '@uniai/firestore';

export interface VerifiedToken {
  uid: string;
  email?: string;
  emailVerified: boolean;
  name?: string;
}

export interface TokenVerifier {
  /** Throws when the token is invalid or expired. */
  verify(idToken: string): Promise<VerifiedToken>;
}

export interface IdentityAdmin {
  /** Invalidates refresh tokens so the user must sign in again. */
  revokeSessions(uid: string): Promise<void>;
}

export const TOKEN_VERIFIER = Symbol('TOKEN_VERIFIER');
export const IDENTITY_ADMIN = Symbol('IDENTITY_ADMIN');

/**
 * Firebase Authentication. Uses the Auth emulator automatically when
 * FIREBASE_AUTH_EMULATOR_HOST is set (local development and emulator tests).
 */
export class FirebaseIdentity implements TokenVerifier, IdentityAdmin {
  async verify(idToken: string): Promise<VerifiedToken> {
    const decoded = await getAuth(getAdminApp()).verifyIdToken(idToken);
    return {
      uid: decoded.uid,
      email: decoded.email,
      emailVerified: decoded.email_verified === true,
      name: typeof decoded.name === 'string' ? decoded.name : undefined,
    };
  }

  async revokeSessions(uid: string): Promise<void> {
    await getAuth(getAdminApp()).revokeRefreshTokens(uid);
  }
}
