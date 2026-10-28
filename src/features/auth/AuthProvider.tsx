import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { service } from '@/data';
import type { Tournament, UserIdentity } from '@/types/domain';

interface AuthState {
  user: UserIdentity | null;
  loading: boolean;
  isOrganizer: boolean;
  /** UI hint only — the server re-checks every write. */
  canManage: (t: Pick<Tournament, 'ownerId'> | null | undefined) => boolean;
}

const AuthContext = createContext<AuthState>({ user: null, loading: true, isOrganizer: false, canManage: () => false });

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['auth-user'], queryFn: () => service.auth.getUser(), staleTime: 60_000 });
  useEffect(() => service.auth.onChange(() => { void qc.invalidateQueries(); }), [qc]);
  const user = q.data ?? null;
  const isOrganizer = user?.role === 'organizer' || user?.role === 'admin';
  const value: AuthState = {
    user,
    loading: q.isLoading,
    isOrganizer,
    canManage: (t) => !!t && !!user && (user.role === 'admin' || t.ownerId === user.id),
  };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
