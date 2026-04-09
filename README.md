# LastWave – Last.fm Playlist Generator

A Material You Android app that generates playlists from your Last.fm history.

---

## Setup in Android Studio

### Option A: Copy-paste into existing project
1. Open Android Studio → New Project → Empty Views Activity
2. Package name: `com.lastwave.app`
3. Replace the generated `app/` folder with the one from this zip
4. Replace `build.gradle` (root) and `settings.gradle` with the ones from this zip
5. Sync Gradle → Run

### Option B: Open as project
1. Open Android Studio
2. File → Open → select the `LastWave/` folder
3. Let Gradle sync
4. Run on device or emulator

---

## Getting a Last.fm API Key

1. Go to https://www.last.fm/api/account/create
2. Fill in App name: `LastWave`, anything for description
3. Copy the **API key**
4. Open the app → Settings → paste the key → Save

---

## Playlist Modes

| Mode | Description |
|------|-------------|
| Top Tracks | Your most-played tracks (choose time period) |
| Recent Tracks | Latest scrobbles |
| Similar Tracks | Tracks similar to a seed track |
| Similar Artists | Top tracks from artists similar to a seed artist |
| By Tag | Top tracks for a genre/tag (rock, lofi, jazz…) |
| My Mix | Smart blend of all of the above |

## Export Options

- **CSV** – Opens share sheet, save anywhere
- **M3U** – Standard playlist file for media players
- **Share** – Text list via any app (WhatsApp, notes, etc.)
- **You Tube** – Searches the first track on Spotify

---

## Build via GitHub Actions

1. Push this folder to a GitHub repository
2. Actions tab → "Build LastWave APK" → Run workflow
3. Download the APK artifact when complete
