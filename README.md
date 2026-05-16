# SplitMate

**Smart bill splitting. Pay only what you consumed.**

SplitMate is a mobile app (Android + iOS) that lets groups split restaurant bills fairly — each person pays exactly for what they ordered, not an equal share of everything.

---

## Screenshots

> _Coming soon — screenshots placeholder_

---

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | React Native + Expo SDK 51 (managed workflow) |
| Language | TypeScript (strict mode) |
| Routing | Expo Router v3 (file-based) |
| Styling | NativeWind v4 (Tailwind CSS for RN) |
| State | Zustand |
| Backend | Supabase (auth, database, realtime, storage) |
| AI / OCR | OpenAI GPT-4o Vision (via Supabase Edge Function) |
| Animations | React Native Reanimated |
| Camera | Expo Camera + Expo Image Picker |
| QR Codes | expo-barcode-scanner + react-native-qrcode-svg |
| Notifications | Expo Notifications (structure) |
| Monetization | RevenueCat + AdMob (structure only) |

---

## Prerequisites

- **Node.js** 18+
- **npm** or **yarn**
- **Expo CLI**: `npm install -g expo-cli`
- **EAS CLI**: `npm install -g eas-cli`
- **Supabase account**: [supabase.com](https://supabase.com)
- **OpenAI API key** (for real OCR; not needed for demo mode)
- **Expo Go** app on your phone (for development)

---

## Setup Instructions

### 1. Create / clone the project

```bash
cd C:/Users/Ricardo/VaultAI/SplitMate
```

### 2. Install dependencies

```bash
npm install
```

### 3. Set up Supabase

1. Go to [supabase.com](https://supabase.com) and create a new project
2. Run the database migration:
   - Go to **SQL Editor** in your Supabase dashboard
   - Paste the contents of `supabase/migrations/001_initial.sql`
   - Click **Run**
3. Enable Auth providers you want (Google, Apple, etc.) in **Authentication → Providers**
4. Deploy the Edge Function:
   ```bash
   npx supabase login
   npx supabase link --project-ref YOUR_PROJECT_REF
   npx supabase functions deploy parse-receipt
   ```
5. Set the OpenAI secret in Supabase Dashboard → **Edge Functions → Secrets**:
   - Name: `OPENAI_API_KEY`
   - Value: `sk-...your-key...`

### 4. Configure environment variables

Copy `.env.local` and fill in your values:

```bash
EXPO_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=your-anon-key-here
```

Get these from: Supabase Dashboard → **Settings → API**

### 5. Run the app

```bash
npx expo start
```

Then scan the QR code with Expo Go on your phone, or press `a` for Android emulator / `i` for iOS simulator.

### 6. Build for production

```bash
# Configure EAS
eas build:configure

# Build for Android
eas build --platform android

# Build for iOS
eas build --platform ios

# Build both
eas build --platform all
```

---

## Environment Variables

| Variable | Where | Description |
|---|---|---|
| `EXPO_PUBLIC_SUPABASE_URL` | `.env.local` | Your Supabase project URL |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | `.env.local` | Supabase anonymous key (public) |
| `OPENAI_API_KEY` | Supabase Edge Function Secret | OpenAI API key (never in client!) |

---

## App Flow

```
Welcome → Profile Setup
    ↓
Home Screen
    ↓
Scan Receipt (Camera / Upload / Demo)
    ↓
Review & Confirm Receipt
    ↓
Session Screen (QR Code)
    ↓
Others join via QR scan
    ↓
Each person selects their items
    ↓
Dashboard (totals + payment tracking)
    ↓
Close Bill ✓
```

---

## Deep Linking

| URL | Action |
|---|---|
| `splitmate://session/[id]` | Join a split session |
| `splitmate://profile/[id]` | View a user profile |

---

## Monetization Roadmap

### Phase 1 — Free MVP (current)
- Core bill splitting functionality
- Viral growth through QR code sharing
- No ads, no paywall
- Goal: user acquisition and product-market fit

### Phase 2 — AdMob + Pro Plan
- AdMob banner on history/dashboard (non-intrusive)
- **SplitMate Pro** at €2.99/month:
  - Unlimited history
  - Session export (PDF/CSV)
  - Custom avatar upload
  - Ad-free experience

### Phase 3 — B2B Restaurant Partnerships
- Restaurants pay to integrate with their POS
- Direct digital receipt → SplitMate
- Branded experience for restaurants
- Commission on payments processed

### Phase 4 — Fintech Integration
- In-app payment splitting (Revolut/Wise/PayPal API)
- Cashback partnerships with card issuers
- Expense tracking integration

---

## Feature Roadmap

- [ ] iMessage / WhatsApp share integration
- [ ] Recurring splits (flatmates, subscriptions)
- [ ] Multi-currency conversion
- [ ] Receipt photo export with annotations
- [ ] Group history and statistics
- [ ] Apple Pay / Google Pay settlement
- [ ] Restaurant POS API integration
- [ ] Web version (Progressive Web App)

---

## Architecture Decisions

### Why Supabase?
- Real-time subscriptions are essential for live session updates
- Row Level Security gives us per-user data isolation without custom auth logic
- Edge Functions let us keep the OpenAI key server-side only
- Generous free tier for MVP

### Why Expo Managed Workflow?
- Single codebase for iOS + Android
- OTA updates without app store review
- Expo SDK handles camera, image picker, notifications natively

### Why Zustand over Redux?
- Minimal boilerplate for the state complexity needed
- Excellent TypeScript integration
- React hooks API makes components cleaner

### Why NativeWind over StyleSheet?
- Consistent design system via Tailwind classes
- Dark mode via `dark:` prefix
- Easier iteration on UI

### Precision Arithmetic
All monetary calculations use integer cents internally (`toCents()` / `fromCents()`) to avoid floating-point errors. Final display values are rounded to 2 decimal places only at render time.

### QR Code Strategy
- MVP: QR encodes the deep link `splitmate://session/[id]`
- Session data loaded from Supabase when joining
- Offline-capable: if no internet, show last known session data

### Security
- OpenAI API key is **never** in the React Native bundle
- It lives exclusively in the Supabase Edge Function secret
- Row Level Security ensures users can only read/write their own data
- Anonymous Supabase key is safe to expose (read-only per RLS policies)

---

## Project Structure

```
SplitMate/
├── app/                    # Expo Router screens
│   ├── (auth)/            # Auth flow
│   └── (app)/             # Main app (tabs + modals)
├── components/             # Reusable UI components
├── lib/                    # External service clients
├── store/                  # Zustand state stores
├── types/                  # TypeScript type definitions
├── constants/              # Colors, avatars, mock data
├── hooks/                  # Custom React hooks
├── utils/                  # Pure utility functions
└── supabase/               # DB migrations + Edge Functions
```

---

## License

Private — VaultAI © 2025
