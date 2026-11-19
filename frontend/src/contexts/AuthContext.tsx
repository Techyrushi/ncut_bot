import axios from 'axios';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, setApiToken } from '../services/api';
import type { ApiResponse, AuthUser } from '../types/api';

const TOKEN_KEY = 'orbit.access-token';
const USER_KEY = 'orbit.auth-user';

interface AuthState {
  user?: AuthUser;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  updateAccount: (update: { currentPassword: string; email?: string; newPassword?: string }) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthState | undefined>(undefined);

function getStoredUser(): AuthUser | undefined {
  const rawUser = sessionStorage.getItem(USER_KEY);
  if (!rawUser) return undefined;
  try {
    const user = JSON.parse(rawUser) as AuthUser;
    if (user.id && user.email && user.name && (user.role === 'ADMIN' || user.role === 'SALES')) return user;
  } catch {
    sessionStorage.removeItem(USER_KEY);
  }
  return undefined;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser>();
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let active = true;
    const token = sessionStorage.getItem(TOKEN_KEY);
    if (!token) {
      sessionStorage.removeItem(USER_KEY);
      setIsLoading(false);
      return () => {
        active = false;
      };
    }

    setApiToken(token);
    const storedUser = getStoredUser();
    void api
      .get<ApiResponse<AuthUser>>('/auth/me')
      .then(({ data }) => {
        if (!active) return;
        sessionStorage.setItem(USER_KEY, JSON.stringify(data.data));
        setUser(data.data);
      })
      .catch((error: unknown) => {
        if (!active) return;
        if (axios.isAxiosError(error) && error.response?.status === 401) {
          sessionStorage.removeItem(TOKEN_KEY);
          sessionStorage.removeItem(USER_KEY);
          setApiToken();
          setUser(undefined);
          return;
        }
        if (storedUser) setUser(storedUser);
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });

    return () => {
      active = false;
    };
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      user,
      isLoading,
      login: async (email, password) => {
        const { data } = await api.post<ApiResponse<{ token: string; user: AuthUser }>>('/auth/login', {
          email,
          password,
        });
        setApiToken(data.data.token);
        sessionStorage.setItem(TOKEN_KEY, data.data.token);
        sessionStorage.setItem(USER_KEY, JSON.stringify(data.data.user));
        setUser(data.data.user);
      },
      updateAccount: async (update) => {
        const { data } = await api.patch<ApiResponse<{ token: string; user: AuthUser }>>('/auth/account', update);
        setApiToken(data.data.token);
        sessionStorage.setItem(TOKEN_KEY, data.data.token);
        sessionStorage.setItem(USER_KEY, JSON.stringify(data.data.user));
        setUser(data.data.user);
      },
      logout: () => {
        const authorization = api.defaults.headers.common.authorization;
        if (typeof authorization === 'string') {
          void api.post('/auth/logout', {}, { headers: { authorization } }).catch(() => {
            console.error('Unable to revoke the current session on the server.');
          });
        }
        sessionStorage.removeItem(TOKEN_KEY);
        sessionStorage.removeItem(USER_KEY);
        setApiToken();
        setUser(undefined);
      },
    }),
    [user, isLoading],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used within AuthProvider');
  return value;
}
