import { initializeApp } from 'firebase/app';
import { FirebaseError } from 'firebase/app';
import {
  GoogleAuthProvider,
  connectAuthEmulator,
  getAuth,
  signInWithEmailAndPassword,
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

/** Break-glass admin login (ADR 0004). Errors are translated to Vietnamese. */
export async function signInWithPassword(email: string, password: string): Promise<void> {
  try {
    await signInWithEmailAndPassword(getFirebaseAuth(), email.trim(), password);
  } catch (err) {
    const code = err instanceof FirebaseError ? err.code : '';
    if (code === 'auth/too-many-requests') {
      throw new Error('Đăng nhập sai quá nhiều lần. Vui lòng thử lại sau ít phút.', {
        cause: err,
      });
    }
    if (code === 'auth/user-disabled') {
      throw new Error('Tài khoản đã bị vô hiệu hóa.', { cause: err });
    }
    // Same message for unknown email and wrong password, so accounts cannot be probed.
    throw new Error('Email hoặc mật khẩu không đúng.', { cause: err });
  }
}

export async function signOut(): Promise<void> {
  await firebaseSignOut(getFirebaseAuth());
}
