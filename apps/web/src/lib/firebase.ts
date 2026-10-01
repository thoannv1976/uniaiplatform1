import { initializeApp } from 'firebase/app';
import {
  GoogleAuthProvider,
  connectAuthEmulator,
  getAuth,
  signInWithPopup,
  signOut as firebaseSignOut,
  type Auth,
} from 'firebase/auth';
import { EMAIL_DOMAIN, USE_AUTH_EMULATOR, firebaseOptions } from './config';

let auth: Auth | undefined;

export function getFirebaseAuth(): Auth {
  if (!auth) {
    auth = getAuth(initializeApp(firebaseOptions()));
    auth.languageCode = 'vi';
    if (USE_AUTH_EMULATOR) {
      connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
    }
  }
  return auth;
}

export async function signInWithGoogle(): Promise<void> {
  const provider = new GoogleAuthProvider();
  // Only a hint for the account chooser; the API is what actually enforces the domain.
  provider.setCustomParameters({ hd: EMAIL_DOMAIN, prompt: 'select_account' });
  await signInWithPopup(getFirebaseAuth(), provider);
}

export async function signOut(): Promise<void> {
  await firebaseSignOut(getFirebaseAuth());
}
