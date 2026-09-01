import { supabase } from "@/lib/supabase";

function getAvatarFileInfo(localUri: string) {
  const rawExt = localUri.split(".").pop()?.split("?")[0]?.toLowerCase();
  const ext = rawExt && /^[a-z0-9]+$/.test(rawExt) ? rawExt : "jpg";
  const contentType = ext === "png" ? "image/png" : "image/jpeg";
  return { ext: ext === "jpeg" ? "jpg" : ext, contentType };
}

export async function uploadAvatarToStorage(localUri: string, userId: string): Promise<string> {
  if (!userId) throw new Error("Missing user id for avatar upload.");

  const response = await fetch(localUri);
  if (!response.ok) throw new Error("Could not read selected avatar image.");
  const fileData = await response.arrayBuffer();
  const { ext, contentType } = getAvatarFileInfo(localUri);
  const path = `${userId}/avatar.${ext}`;

  const { error } = await supabase.storage
    .from("avatars")
    .upload(path, fileData, {
      contentType,
      upsert: true,
      cacheControl: "3600",
    });

  if (error) throw error;

  const { data } = supabase.storage.from("avatars").getPublicUrl(path);
  return `${data.publicUrl}?t=${Date.now()}`;
}
