import React, { useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  Image,
  ScrollView,
  StyleSheet,
  useColorScheme,
  Alert,
  ActivityIndicator,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import { Ionicons } from "@expo/vector-icons";
import { Colors, USER_COLORS, getColorForIndex } from "@/constants/colors";
import { AVATAR_OPTIONS } from "@/constants/avatars";
import { useAuthStore } from "@/store/authStore";
import { upsertProfile } from "@/lib/supabase";
import { UserProfile } from "@/types";

export default function ProfileSetupScreen() {
  const isDark = useColorScheme() === "dark";
  const { user, setProfile } = useAuthStore();

  const [name, setName] = useState("");
  const [avatarUri, setAvatarUri] = useState<string | null>(null);
  const [selectedIcon, setSelectedIcon] = useState<string | null>(null);
  const [colorIndex, setColorIndex] = useState(0);
  const [saving, setSaving] = useState(false);

  const textColor = isDark ? Colors.textPrimaryDark : Colors.textPrimaryLight;
  const mutedColor = isDark ? Colors.textMutedDark : Colors.textMutedLight;
  const cardColor = isDark ? Colors.cardDark : Colors.cardLight;
  const borderColor = isDark ? Colors.cardBorderDark : Colors.cardBorderLight;
  const bgColor = isDark ? Colors.bgDark : Colors.bgLight;

  const userColor = USER_COLORS[colorIndex % USER_COLORS.length];

  const mapProvider = (provider: unknown): UserProfile["provider"] => {
    if (provider === "azure") return "microsoft";
    if (
      provider === "google" ||
      provider === "apple" ||
      provider === "email" ||
      provider === "microsoft" ||
      provider === "facebook"
    ) {
      return provider;
    }
    return undefined;
  };

  const pickFromGallery = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.8,
    });
    if (!result.canceled && result.assets[0]) {
      setAvatarUri(result.assets[0].uri);
      setSelectedIcon(null);
    }
  };

  const takePhoto = async () => {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      Alert.alert("Permission needed", "Camera access required.");
      return;
    }
    const result = await ImagePicker.launchCameraAsync({
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.8,
    });
    if (!result.canceled && result.assets[0]) {
      setAvatarUri(result.assets[0].uri);
      setSelectedIcon(null);
    }
  };

  const handleSave = async () => {
    if (!name.trim()) {
      Alert.alert("Name required", "Please enter your display name.");
      return;
    }

    setSaving(true);
    try {
      const profile = {
        id: user?.id ?? `guest_${Date.now()}`,
        name: name.trim(),
        email: user?.email,
        avatar_url: avatarUri ?? undefined,
        avatar_icon: selectedIcon ?? "star",
        color: userColor,
        provider: user?.app_metadata?.provider,
      };

      if (user) {
        await upsertProfile(profile);
      }

      setProfile({
        id: profile.id,
        name: profile.name,
        email: profile.email,
        avatarUrl: profile.avatar_url,
        avatarIcon: profile.avatar_icon,
        color: profile.color,
        provider: mapProvider(profile.provider),
        billCredits: 3,
        referralCount: 0,
        isPro: false,
      });

      router.replace("/(app)");
    } catch (err) {
      Alert.alert("Error", "Failed to save profile. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  const preview = avatarUri ? (
    <Image source={{ uri: avatarUri }} style={[styles.avatarPreview, { borderColor: userColor }]} />
  ) : selectedIcon ? (
    <View style={[styles.avatarPreview, styles.emojiPreview, { backgroundColor: userColor + "33", borderColor: userColor }]}>
      <Text style={{ fontSize: 44 }}>
        {AVATAR_OPTIONS.find((a) => a.id === selectedIcon)?.emoji ?? "⭐"}
      </Text>
    </View>
  ) : (
    <View style={[styles.avatarPreview, styles.emojiPreview, { backgroundColor: userColor + "33", borderColor: userColor }]}>
      <Ionicons name="person-outline" size={44} color={userColor} />
    </View>
  );

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: bgColor }]}>
      <ScrollView contentContainerStyle={styles.scroll}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={[styles.title, { color: textColor }]}>Set up your profile</Text>
          <Text style={[styles.subtitle, { color: mutedColor }]}>
            Others will see this when you join a split
          </Text>
        </View>

        {/* Avatar preview */}
        <View style={styles.previewSection}>{preview}</View>

        {/* Photo options */}
        <View style={styles.photoOptions}>
          <TouchableOpacity
            style={[styles.photoBtn, { borderColor }]}
            onPress={pickFromGallery}
          >
            <Ionicons name="image-outline" size={20} color={Colors.primary} />
            <Text style={[styles.photoBtnText, { color: textColor }]}>Gallery</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.photoBtn, { borderColor }]}
            onPress={takePhoto}
          >
            <Ionicons name="camera-outline" size={20} color={Colors.primary} />
            <Text style={[styles.photoBtnText, { color: textColor }]}>Camera</Text>
          </TouchableOpacity>
        </View>

        {/* Avatar icons */}
        <Text style={[styles.sectionLabel, { color: mutedColor }]}>
          Or choose an icon
        </Text>
        <View style={styles.iconGrid}>
          {AVATAR_OPTIONS.map((avatar) => (
            <TouchableOpacity
              key={avatar.id}
              style={[
                styles.iconBtn,
                {
                  backgroundColor:
                    selectedIcon === avatar.id
                      ? userColor + "33"
                      : cardColor,
                  borderColor:
                    selectedIcon === avatar.id ? userColor : borderColor,
                  borderWidth: selectedIcon === avatar.id ? 2 : 1,
                },
              ]}
              onPress={() => {
                setSelectedIcon(avatar.id);
                setAvatarUri(null);
              }}
            >
              <Text style={{ fontSize: 28 }}>{avatar.emoji}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Color picker */}
        <Text style={[styles.sectionLabel, { color: mutedColor }]}>
          Your color
        </Text>
        <View style={styles.colorRow}>
          {USER_COLORS.map((color, i) => (
            <TouchableOpacity
              key={color}
              style={[
                styles.colorDot,
                { backgroundColor: color },
                colorIndex === i && styles.colorDotSelected,
              ]}
              onPress={() => setColorIndex(i)}
            >
              {colorIndex === i && (
                <Ionicons name="checkmark" size={16} color="#fff" />
              )}
            </TouchableOpacity>
          ))}
        </View>

        {/* Name input */}
        <Text style={[styles.sectionLabel, { color: mutedColor }]}>
          Display name
        </Text>
        <TextInput
          style={[
            styles.nameInput,
            {
              color: textColor,
              borderColor,
              backgroundColor: cardColor,
            },
          ]}
          value={name}
          onChangeText={setName}
          placeholder="Your name"
          placeholderTextColor={mutedColor}
          autoCapitalize="words"
          maxLength={32}
        />

        {/* Save button */}
        <TouchableOpacity
          style={[styles.saveBtn, saving && { opacity: 0.6 }]}
          onPress={handleSave}
          disabled={saving}
        >
          {saving ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.saveBtnText}>Continue →</Text>
          )}
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  scroll: {
    flexGrow: 1,
    paddingHorizontal: 24,
    paddingBottom: 40,
  },
  header: {
    paddingTop: 40,
    paddingBottom: 24,
    gap: 6,
  },
  title: {
    fontSize: 28,
    fontWeight: "800",
  },
  subtitle: {
    fontSize: 15,
  },
  previewSection: {
    alignItems: "center",
    marginBottom: 20,
  },
  avatarPreview: {
    width: 100,
    height: 100,
    borderRadius: 50,
    borderWidth: 3,
  },
  emojiPreview: {
    alignItems: "center",
    justifyContent: "center",
  },
  photoOptions: {
    flexDirection: "row",
    gap: 12,
    marginBottom: 24,
  },
  photoBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1,
    gap: 8,
  },
  photoBtnText: {
    fontSize: 14,
    fontWeight: "600",
  },
  sectionLabel: {
    fontSize: 13,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 10,
    marginTop: 8,
  },
  iconGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    marginBottom: 24,
  },
  iconBtn: {
    width: 56,
    height: 56,
    borderRadius: 14,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  colorRow: {
    flexDirection: "row",
    gap: 12,
    marginBottom: 24,
    flexWrap: "wrap",
  },
  colorDot: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  colorDotSelected: {
    borderWidth: 3,
    borderColor: "rgba(255,255,255,0.8)",
  },
  nameInput: {
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 16,
    fontSize: 18,
    marginBottom: 24,
  },
  saveBtn: {
    backgroundColor: Colors.primary,
    paddingVertical: 18,
    borderRadius: 14,
    alignItems: "center",
  },
  saveBtnText: {
    color: "#fff",
    fontSize: 17,
    fontWeight: "700",
  },
});
