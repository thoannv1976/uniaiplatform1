import { onIdTokenChanged, type User } from 'firebase/auth';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { getFirebaseAuth, signInWithGoogle, signOut } from '../lib/firebase';

export interface AuthState {
  /** undefined while Firebase restores the session. */
  user: User | null | undefined;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null | undefined>(undefined);

  useEffect(() => onIdTokenChanged(getFirebaseAuth(), setUser), []);

  return (
    <AuthContext.Provider value={{ user, signIn: signInWithGoogle, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth phải nằm trong <AuthProvider>');
  return value;
}
