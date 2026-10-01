import { getAuth } from 'firebase-admin/auth';
import { getAdminApp } from '@uniai/firestore';

export interface VerifiedToken {
  uid: string;
  email?: string;
  emailVerified: boolean;
  name?: string;
}

export interface TokenVerifier {
  /** Throws when the token is invalid, expired or revoked. */
  verify(idToken: string): Promise<VerifiedToken>;
}

export const TOKEN_VERIFIER = Symbol('TOKEN_VERIFIER');

/**
 * Verifies Firebase Authentication ID tokens. Uses the Auth emulator automatically when
 * FIREBASE_AUTH_EMULATOR_HOST is set (local development and emulator tests).
 */
export class FirebaseTokenVerifier implements TokenVerifier {
  async verify(idToken: string): Promise<VerifiedToken> {
    const decoded = await getAuth(getAdminApp()).verifyIdToken(idToken);
    return {
      uid: decoded.uid,
      email: decoded.email,
      emailVerified: decoded.email_verified === true,
      name: typeof decoded.name === 'string' ? decoded.name : undefined,
    };
  }
}
