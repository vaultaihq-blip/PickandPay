import { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  Alert,
  ScrollView,
  TextInput,
  Share,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Stack, useRouter } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '@/lib/supabase';
import { Avatar } from '@/components/ui/Avatar';
import AsyncStorage from '@react-native-async-storage/async-storage';

export default function ProfileScreen() {
  const router = useRouter();
  const [user, setUser] = useState<any>(null);
  const [profile, setProfile] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');

  // Reload profile whenever screen comes into focus (e.g. returning from avatar-picker)
  useFocusEffect(
    useCallback(() => {
      loadProfile();
    }, [])
  );

  async function loadProfile() {
    try {
      const { data: { user: authUser } } = await supabase.auth.getUser();

      if (!authUser) {
        setLoading(false);
        return;
      }

      setUser(authUser);

      const { data: profileData } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', authUser.id)
        .single();

      if (profileData) {
        setProfile(profileData);
        setName(profileData.name || '');
        setPhone(profileData.phone || '');
      }

      setLoading(false);
    } catch (error) {
      console.error('[profile] Error:', error);
      setLoading(false);
    }
  }

  async function handleSaveProfile() {
    try {
      const { error } = await supabase
        .from('profiles')
        .update({ name, phone })
        .eq('id', user.id);

      if (error) throw error;

      Alert.alert('Saved', 'Profile updated successfully.');
      loadProfile();
    } catch {
      Alert.alert('Error', 'Could not update profile');
    }
  }

  async function shareApp() {
    const appLink =
      Platform.OS === 'ios'
        ? 'https://apps.apple.com/app/pickandpay/id123456789'
        : 'https://play.google.com/store/apps/details?id=com.pickandpay';

    await Share.share({
      message: `Check out Pick&Pay - The easiest way for groups to split bills fairly and avoid awkward conversations. Join now and get 3 free bills to split.\n\n${appLink}`,
      title: 'Try Pick&Pay',
    });
  }

  async function shareReferralLink() {
    const appLink =
      Platform.OS === 'ios'
        ? 'https://apps.apple.com/app/pickandpay/id123456789'
        : 'https://play.google.com/store/apps/details?id=com.pickandpay';

    const referralLink = `${appLink}?ref=${user.id}`;

    await Share.share({
      message: `Check out Pick&Pay - The easiest way for groups to split bills fairly and avoid awkward conversations. Join now and get 3 free bills to split.\n\n${referralLink}`,
      title: 'Invite Friends to Pick&Pay',
    });
  }

  async function handleLogout() {
    try {
      await AsyncStorage.clear();
      await supabase.auth.signOut();
      router.replace('/(auth)/welcome');
    } catch {
      Alert.alert('Error', 'Could not log out');
    }
  }

  if (loading) {
    return (
      <SafeAreaView style={styles.safeContainer}>
        <Stack.Screen options={{ headerShown: false }} />
        <View style={styles.navHeader}>
          <Pressable onPress={() => router.back()} style={styles.backBtn}>
            <Ionicons name="arrow-back" size={24} color="#000" />
          </Pressable>
          <Text style={styles.navTitle}>Profile</Text>
          <View style={{ width: 40 }} />
        </View>
        <View style={styles.centered}>
          <Text style={styles.loadingText}>Loading...</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (!user) {
    return (
      <SafeAreaView style={styles.safeContainer}>
        <Stack.Screen options={{ headerShown: false }} />
        <View style={styles.navHeader}>
          <Pressable onPress={() => router.back()} style={styles.backBtn}>
            <Ionicons name="arrow-back" size={24} color="#000" />
          </Pressable>
          <Text style={styles.navTitle}>Profile</Text>
          <View style={{ width: 40 }} />
        </View>
        <View style={styles.centered}>
          <Text style={styles.errorText}>Not signed in</Text>
          <Pressable onPress={() => router.replace('/(auth)/welcome')} style={styles.button}>
            <Text style={styles.buttonText}>Go to Login</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeContainer}>
      <Stack.Screen options={{ headerShown: false }} />

      {/* Custom header with back button */}
      <View style={styles.navHeader}>
        <Pressable onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={24} color="#000" />
        </Pressable>
        <Text style={styles.navTitle}>Profile</Text>
        <View style={{ width: 40 }} />
      </View>

    <ScrollView style={styles.container}>
      {/* Avatar Section */}
      <View style={styles.avatarSection}>
        <Pressable
          onPress={() => router.push('/(app)/avatar-picker')}
          style={styles.avatarContainer}
        >
          <Avatar
            name={profile?.name || user.email}
            avatarIcon={profile?.avatar_icon}
            avatarUrl={profile?.avatar_url}
            color={profile?.color}
            size={112}
          />
          <View style={styles.editBadge}>
            <Text style={styles.editIcon}>✏️</Text>
          </View>
        </Pressable>
        <Text style={styles.chooseText}>Choose Profile Picture</Text>
      </View>

      {/* Name (editable) */}
      <View style={styles.section}>
        <Text style={styles.label}>Name</Text>
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder="Your name"
          placeholderTextColor="#999"
          style={styles.input}
        />
      </View>

      {/* Email (read-only) */}
      <View style={styles.section}>
        <Text style={styles.label}>📧 Email (for reminders)</Text>
        <Text style={styles.value}>{user.email}</Text>
        <Text style={styles.hint}>(from your account)</Text>
      </View>

      {/* Phone (editable) */}
      <View style={styles.section}>
        <Text style={styles.label}>📱 Phone (optional)</Text>
        <TextInput
          value={phone}
          onChangeText={setPhone}
          placeholder="+351 912 345 678"
          placeholderTextColor="#999"
          keyboardType="phone-pad"
          style={styles.input}
        />
        <Text style={styles.hint}>Used for WhatsApp reminders</Text>
        <Pressable onPress={handleSaveProfile} style={styles.saveButton}>
          <Text style={styles.saveButtonText}>Save Changes</Text>
        </Pressable>
      </View>

      {/* Credits Section */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>📊 Your Credits</Text>
        <View style={styles.creditsCard}>
          <View style={styles.creditsRow}>
            <Text style={styles.creditsLabel}>Free trial:</Text>
            <Text style={styles.creditsValue}>3 bills ✓ used</Text>
          </View>
          <View style={styles.creditsRow}>
            <Text style={styles.creditsLabel}>Purchased:</Text>
            <Text style={styles.creditsValue}>0 bills</Text>
          </View>
          <View style={styles.creditsRow}>
            <Text style={styles.creditsLabel}>Referral bonus:</Text>
            <Text style={styles.creditsValue}>{profile?.referral_count || 0} bills</Text>
          </View>
          <View style={styles.divider} />
          <View style={styles.creditsRow}>
            <Text style={styles.creditsTotalLabel}>Total remaining:</Text>
            <Text style={styles.creditsTotalValue}>
              {profile?.bill_credits || 0} bills 🎉
            </Text>
          </View>
        </View>

        <Pressable onPress={() => router.push('/(app)/paywall')} style={styles.buyButton}>
          <Text style={styles.buyButtonText}>Buy More Credits</Text>
        </Pressable>
      </View>

      {/* Referrals */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>👥 Invite Friends &amp; Earn Credits</Text>
        <Text style={styles.referralText}>
          Invite friends and you both get +1 free bill!{'\n'}(Max 5 referrals)
        </Text>
        <Pressable onPress={shareReferralLink} style={styles.referralButton}>
          <Text style={styles.referralButtonText}>
            👥 Invite Friends (+1 bill per friend, up to 5 referrals)
          </Text>
        </Pressable>
        {(profile?.referral_count ?? 0) >= 5 && (
          <Text style={styles.discountText}>
            🎁 You've unlocked 20% discount on your next pack!
          </Text>
        )}
      </View>

      {/* Actions */}
      <View style={styles.section}>
        <Pressable onPress={shareApp} style={styles.actionButton}>
          <Text style={styles.actionButtonText}>📱 Share Pick&amp;Pay</Text>
        </Pressable>

        <Pressable onPress={() => router.push('/onboarding')} style={styles.actionButton}>
          <Text style={styles.actionButtonText}>📖 View Tutorial</Text>
        </Pressable>
      </View>

      {/* Logout */}
      <Pressable onPress={handleLogout} style={styles.logoutButton}>
        <Text style={styles.logoutText}>Log Out</Text>
      </Pressable>

      <View style={{ height: 40 }} />
    </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeContainer: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
  container: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
  navHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E0E0E0',
  },
  navTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: '#000',
  },
  backBtn: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  loadingText: {
    color: '#666',
    fontSize: 16,
  },
  errorText: {
    color: '#EF4444',
    fontSize: 18,
    marginBottom: 24,
  },
  button: {
    backgroundColor: '#3B82F6',
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 8,
  },
  buttonText: {
    color: '#FFF',
    fontSize: 16,
    fontWeight: '600',
  },
  avatarSection: {
    alignItems: 'center',
    paddingVertical: 32,
  },
  avatarContainer: {
    position: 'relative',
  },
  editBadge: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    backgroundColor: '#3B82F6',
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  editIcon: {
    fontSize: 16,
  },
  chooseText: {
    marginTop: 12,
    fontSize: 14,
    color: '#666',
  },
  section: {
    paddingHorizontal: 20,
    marginBottom: 24,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#000',
    marginBottom: 12,
  },
  label: {
    fontSize: 14,
    fontWeight: '600',
    color: '#666',
    marginBottom: 8,
  },
  value: {
    fontSize: 16,
    color: '#000',
  },
  hint: {
    fontSize: 12,
    color: '#999',
    marginTop: 4,
  },
  input: {
    backgroundColor: '#F5F5F5',
    borderWidth: 1,
    borderColor: '#E0E0E0',
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
    color: '#000',
    marginBottom: 8,
  },
  saveButton: {
    backgroundColor: '#3B82F6',
    padding: 12,
    borderRadius: 8,
    alignItems: 'center',
    marginTop: 8,
  },
  saveButtonText: {
    color: '#FFF',
    fontSize: 14,
    fontWeight: '600',
  },
  creditsCard: {
    backgroundColor: '#F9F9F9',
    borderWidth: 1,
    borderColor: '#E0E0E0',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
  },
  creditsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  creditsLabel: {
    fontSize: 14,
    color: '#666',
  },
  creditsValue: {
    fontSize: 14,
    color: '#000',
  },
  divider: {
    height: 1,
    backgroundColor: '#E0E0E0',
    marginVertical: 12,
  },
  creditsTotalLabel: {
    fontSize: 16,
    fontWeight: '600',
    color: '#000',
  },
  creditsTotalValue: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#3B82F6',
  },
  buyButton: {
    backgroundColor: '#3B82F6',
    padding: 14,
    borderRadius: 8,
    alignItems: 'center',
  },
  buyButtonText: {
    color: '#FFF',
    fontSize: 16,
    fontWeight: '600',
  },
  referralText: {
    fontSize: 14,
    color: '#666',
    marginBottom: 12,
    lineHeight: 20,
  },
  referralButton: {
    backgroundColor: '#F0F4FF',
    borderWidth: 1,
    borderColor: '#3B82F6',
    padding: 14,
    borderRadius: 8,
    alignItems: 'center',
  },
  referralButtonText: {
    color: '#3B82F6',
    fontSize: 14,
    fontWeight: '600',
  },
  discountText: {
    marginTop: 12,
    fontSize: 14,
    color: '#10B981',
    textAlign: 'center',
  },
  actionButton: {
    backgroundColor: '#F5F5F5',
    borderWidth: 1,
    borderColor: '#E0E0E0',
    padding: 14,
    borderRadius: 8,
    alignItems: 'center',
    marginBottom: 12,
  },
  actionButtonText: {
    color: '#000',
    fontSize: 16,
  },
  logoutButton: {
    marginHorizontal: 20,
    marginTop: 8,
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: '#EF4444',
    padding: 14,
    borderRadius: 8,
    alignItems: 'center',
  },
  logoutText: {
    color: '#EF4444',
    fontSize: 16,
    fontWeight: '600',
  },
});
