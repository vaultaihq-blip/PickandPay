type AuthProfileSource = {
  email?: string;
  user_metadata?: Record<string, unknown>;
  identities?: Array<{ identity_data?: Record<string, unknown> | null }> | null;
};

function readString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

export function getAuthDisplayName(user: AuthProfileSource) {
  return (
    readString(user.user_metadata?.full_name) ??
    readString(user.user_metadata?.name) ??
    readString(user.email) ??
    "User"
  );
}

export function getAuthAvatarUrl(user: AuthProfileSource) {
  const identityData = user.identities?.[0]?.identity_data;

  return (
    readString(user.user_metadata?.avatar_url) ??
    readString(user.user_metadata?.picture) ??
    readString(user.user_metadata?.image) ??
    readString(identityData?.avatar_url) ??
    readString(identityData?.picture)
  );
}
