import { useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuthStore } from './store/auth-store.js';
import LoginPage from './pages/login-page.js';
import HomePage from './pages/home-page.js';
import ProjectPage from './pages/project-page.js';
import MeetingFloat from './pages/meeting-float.js';

function RequireAuth({ children }: { children: React.ReactNode }) {
  const user = useAuthStore((s) => s.user);
  const isLoading = useAuthStore((s) => s.isLoading);
  if (isLoading) return <div className="min-h-screen flex items-center justify-center"><span className="text-gray-400 text-sm">加载中…</span></div>;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export default function App() {
  const setUser = useAuthStore((s) => s.setUser);
  const setLoading = useAuthStore((s) => s.setLoading);

  // Why: on every cold launch we check if there's an existing main-process session
  // (e.g. the user quit the app without logging out) and restore UI state from it.
  useEffect(() => {
    if (!window.api) {
      console.error('[App] window.api is undefined — preload did not run');
      setLoading(false);
      return;
    }
    window.api.auth.session().then((res) => {
      if (res.ok && res.data) {
        setUser({ userId: res.data.userId, email: res.data.email, displayName: res.data.displayName, licenseStatus: res.data.licenseStatus, offlineDaysLeft: res.data.offlineDaysLeft });
      } else {
        setUser(null);
      }
      setLoading(false);
    }).catch((err: unknown) => {
      console.error('[App] session check failed:', err);
      setUser(null);
      setLoading(false);
    });
  }, [setUser, setLoading]);

  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/"
        element={
          <RequireAuth>
            <HomePage />
          </RequireAuth>
        }
      />
      <Route
        path="/projects/:id"
        element={
          <RequireAuth>
            <ProjectPage />
          </RequireAuth>
        }
      />
      {/* Why: meeting-float is a standalone pill window — no auth wrapper needed. */}
      <Route path="/meeting-float" element={<MeetingFloat />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
