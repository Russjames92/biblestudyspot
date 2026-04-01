import { createContext, useContext, useState, useCallback, Component, type ReactNode } from "react";
import { setAuthToken } from "./queryClient";

interface AuthInfo {
  role: "admin" | "teacher" | null;
  teacherId?: number;
  name?: string;
  username?: string;
}

interface AuthContextValue {
  auth: AuthInfo;
  loginAsAdmin: (username: string) => void;
  loginAsTeacher: (teacherId: number, name: string) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue>({
  auth: { role: null },
  loginAsAdmin: () => {},
  loginAsTeacher: () => {},
  logout: () => {},
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [auth, setAuth] = useState<AuthInfo>({ role: null });

  const loginAsAdmin = useCallback((username: string) => {
    setAuth({ role: "admin", username });
  }, []);

  const loginAsTeacher = useCallback((teacherId: number, name: string) => {
    setAuth({ role: "teacher", teacherId, name });
  }, []);

  const logout = useCallback(() => {
    setAuthToken(null);
    setAuth({ role: null });
  }, []);

  return (
    <AuthContext.Provider value={{ auth, loginAsAdmin, loginAsTeacher, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}

// Error boundary to catch React #310 and recover gracefully
interface EBState { hasError: boolean; key: number; }
export class AuthErrorBoundary extends Component<{ children: ReactNode }, EBState> {
  state = { hasError: false, key: 0 };
  static getDerivedStateFromError() { return { hasError: true }; }
  componentDidCatch() {
    // Reset after a tick so React can recover
    setTimeout(() => this.setState(s => ({ hasError: false, key: s.key + 1 })), 50);
  }
  render() {
    if (this.state.hasError) return null;
    return <div key={this.state.key}>{this.props.children}</div>;
  }
}
