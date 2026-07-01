"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
} from "react";

type User = { email: string; name: string; picture?: string };

type AuthContextType = {
  accessToken: string | null;
  user: User | null;
  isReady: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshToken: () => Promise<string | null>;
};

const AuthContext = createContext<AuthContextType>(null!);
export const useAuth = () => useContext(AuthContext);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [isReady, setIsReady] = useState(false);

  const refreshToken = useCallback(async (): Promise<string | null> => {
    try {
      const res = await fetch("/api/auth/refresh", { method: "POST" });
      if (!res.ok) return null;
      const data = await res.json();
      setAccessToken(data.accessToken);
      return data.accessToken;
    } catch {
      setAccessToken(null);
      return null;
    }
  }, []);

  const fetchUser = useCallback(async (token: string) => {
    try {
      const res = await fetch("/api/auth/profile", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) setUser(await res.json());
    } catch {
      setUser(null);
    }
  }, []);

  // 앱 마운트 시 세션 복원
  useEffect(() => {
    (async () => {
      const token = await refreshToken();
      if (token) await fetchUser(token);
      setIsReady(true);
    })();
  }, [refreshToken, fetchUser]);

  const login = async (email: string, password: string) => {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error ?? "로그인 실패");
    }

    const data = await res.json();
    setAccessToken(data.accessToken);
    await fetchUser(data.accessToken);
  };

  const logout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    setAccessToken(null);
    setUser(null);
    window.location.href = "/login";
  };

  if (!isReady) return null;

  return (
    <AuthContext.Provider
      value={{ accessToken, user, isReady, login, logout, refreshToken }}
    >
      {children}
    </AuthContext.Provider>
  );
}
