import { onIdTokenChanged, type User } from 'firebase/auth';
import type { MeResponse } from '@uniai/shared';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { fetchMe } from '../lib/api';
import { getFirebaseAuth, signInWithGoogle, signInWithPassword, signOut } from '../lib/firebase';

export type ProfileState =
  { kind: 'loading' } | { kind: 'ok'; profile: MeResponse } | { kind: 'error'; message: string };

export interface AuthState {
  /** undefined while Firebase restores the session. */
  user: User | null | undefined;
  profile: ProfileState;
  getToken: () => Promise<string>;
  refreshProfile: () => void;
  signIn: () => Promise<void>;
  signInWithPassword: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  // Tagged with the user and a revision so stale results read as "loading".
  const [result, setResult] = useState<{ user: User; rev: number; state: ProfileState } | null>(
    null,
  );
  const [rev, setRev] = useState(0);

  useEffect(() => onIdTokenChanged(getFirebaseAuth(), setUser), []);

  useEffect(() => {
    if (!user) return;
    const controller = new AbortController();
    user
      .getIdToken()
      .then((token) => fetchMe(token, controller.signal))
      .then((profile) => setResult({ user, rev, state: { kind: 'ok', profile } }))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        const message = err instanceof Error ? err.message : String(err);
        setResult({ user, rev, state: { kind: 'error', message } });
      });
    return () => controller.abort();
  }, [user, rev]);

  const profile: ProfileState =
    user && result?.user === user && result.rev === rev ? result.state : { kind: 'loading' };

  const getToken = useCallback(async () => {
    const current = getFirebaseAuth().currentUser;
    if (!current) throw new Error('Bạn chưa đăng nhập.');
    return current.getIdToken();
  }, []);

  return (
    <AuthContext.Provider
      value={{
        user,
        profile,
        getToken,
        refreshProfile: () => setRev((r) => r + 1),
        signIn: signInWithGoogle,
        signInWithPassword,
        signOut,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth phải nằm trong <AuthProvider>');
  return value;
}
