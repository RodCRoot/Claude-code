import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { api, setToken, getToken } from "./api";

export interface User {
  id: string;
  email: string;
  name: string;
  role: "ADMIN" | "COACH" | "ATHLETE";
  orgId: string;
}

interface AuthState {
  user: User | null;
  athleteId: string | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthState>(null as unknown as AuthState);
export const useAuth = () => useContext(AuthContext);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [athleteId, setAthleteId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!getToken()) { setLoading(false); return; }
    api
      .get<{ user: User; athleteId: string | null }>("/auth/me")
      .then((r) => { setUser(r.user); setAthleteId(r.athleteId); })
      .catch(() => setToken(null))
      .finally(() => setLoading(false));
  }, []);

  async function login(email: string, password: string) {
    const r = await api.post<{ token: string; user: User }>("/auth/login", { email, password });
    setToken(r.token);
    const me = await api.get<{ user: User; athleteId: string | null }>("/auth/me");
    setUser(me.user);
    setAthleteId(me.athleteId);
  }

  function logout() {
    setToken(null);
    setUser(null);
    setAthleteId(null);
  }

  return (
    <AuthContext.Provider value={{ user, athleteId, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}
