import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, ApiError } from './api';

export type UserRole = 'admin' | 'operator' | 'viewer';
export type Permission =
  | 'systems.manage'
  | 'analyze'
  | 'alerts.ack'
  | 'settings.manage'
  | 'users.manage';

export interface CurrentUser {
  id: number;
  username: string;
  role: UserRole;
}

interface AuthState {
  user: CurrentUser | null;
  permissions: Permission[];
  loading: boolean;
  logout: () => Promise<void>;
  markLoggedIn: (user: CurrentUser, permissions?: Permission[]) => void;
  hasPermission: (perm: Permission) => boolean;
}

const AuthContext = createContext<AuthState>({
  user: null,
  permissions: [],
  loading: true,
  logout: async () => {},
  markLoggedIn: () => {},
  hasPermission: () => false,
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const res = await api.me();
        setUser(res.user);
        setPermissions((res.permissions ?? []) as Permission[]);
      } catch {
        setUser(null);
        setPermissions([]);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    const onUnauthorized = () => {
      setUser(null);
      setPermissions([]);
    };
    window.addEventListener('xm:unauthorized', onUnauthorized);
    return () => window.removeEventListener('xm:unauthorized', onUnauthorized);
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      // 即使请求失败也本地登出
    }
    setUser(null);
    setPermissions([]);
  }, []);

  const markLoggedIn = useCallback((u: CurrentUser, perms?: Permission[]) => {
    setUser(u);
    if (perms) setPermissions(perms);
    window.dispatchEvent(new CustomEvent('xm:logged-in'));
  }, []);

  const hasPermission = useCallback((perm: Permission) => permissions.includes(perm), [permissions]);

  const value = useMemo(
    () => ({ user, permissions, loading, logout, markLoggedIn, hasPermission }),
    [user, permissions, loading, logout, markLoggedIn, hasPermission],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  return useContext(AuthContext);
}

export function isUnauthorized(e: unknown): boolean {
  return e instanceof ApiError && e.status === 401;
}

export const ROLE_LABELS: Record<UserRole, string> = {
  admin: '管理员',
  operator: '运维员',
  viewer: '查看员',
};
