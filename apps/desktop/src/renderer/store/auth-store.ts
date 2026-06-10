import { create } from 'zustand';

interface AuthUser {
  userId: string;
  email: string;
  displayName?: string;
  licenseStatus: 'active' | 'expired' | 'none';
  // null = online (verified this launch), 0 = grace expired (readonly), 1-7 = offline grace period
  offlineDaysLeft: number | null;
}

interface AuthState {
  user: AuthUser | null;
  isLoading: boolean;
  setUser: (user: AuthUser | null) => void;
  setLoading: (loading: boolean) => void;
}

// Why: auth state lives in Zustand (not TanStack Query) because it is not
// server-derived data — it comes from the main process session store via IPC.
export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  isLoading: true,
  setUser: (user) => set({ user }),
  setLoading: (isLoading) => set({ isLoading }),
}));

// Why: stable selector avoids re-renders in components that only care about
// the offline countdown, not other user fields.
export const useOfflineDaysLeft = () => useAuthStore((s) => s.user?.offlineDaysLeft ?? null);
