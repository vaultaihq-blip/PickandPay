import { useEffect } from "react";
import { useAuthStore } from "@/store/authStore";

export function useAuth() {
  const {
    user,
    profile,
    session,
    isLoading,
    isGuest,
    initialized,
    isAuthenticated: isAuthenticatedStore,
    initialize,
    setGuest,
    signOut,
    loadProfile,
    setProfile,
  } = useAuthStore();

  useEffect(() => {
    if (!initialized) {
      initialize();
    }
  }, [initialized, initialize]);

  const isAuthenticated = isAuthenticatedStore || !!user || isGuest;
  const hasProfile = !!profile;

  return {
    user,
    profile,
    session,
    isLoading,
    isGuest,
    initialized,
    isAuthenticated,
    hasProfile,
    setGuest,
    signOut,
    loadProfile,
    setProfile,
  };
}
