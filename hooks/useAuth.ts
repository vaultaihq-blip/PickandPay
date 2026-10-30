import { useEffect } from "react";
import { useAuthStore } from "@/store/authStore";

export function useAuth() {
  const {
    user,
    profile,
    session,
    isLoading,
    initialized,
    isAuthenticated: isAuthenticatedStore,
    initialize,
    signOut,
    loadProfile,
    setProfile,
  } = useAuthStore();

  useEffect(() => {
    if (!initialized) {
      initialize();
    }
  }, [initialized, initialize]);

  const isAuthenticated = isAuthenticatedStore || !!user;
  const hasProfile = !!profile;

  return {
    user,
    profile,
    session,
    isLoading,
    initialized,
    isAuthenticated,
    hasProfile,
    signOut,
    loadProfile,
    setProfile,
  };
}
