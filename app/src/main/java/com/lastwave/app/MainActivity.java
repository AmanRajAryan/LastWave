package com.lastwave.app;

import android.graphics.Color;
import android.Manifest;
import android.app.WallpaperManager;
import android.annotation.SuppressLint;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.os.Environment;
import android.webkit.*;
import android.widget.Toast;
import androidx.activity.OnBackPressedCallback;
import androidx.annotation.Nullable;
import androidx.appcompat.app.AppCompatActivity;
import androidx.browser.customtabs.CustomTabColorSchemeParams;
import androidx.browser.customtabs.CustomTabsIntent;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewClientCompat;
import androidx.webkit.WebSettingsCompat;
import androidx.webkit.WebViewFeature;
import java.io.*;
import java.io.IOException;
import java.nio.charset.StandardCharsets;

// API 27+ only — guarded by Build.VERSION check at runtime
import android.app.WallpaperColors;

// Android 12+ SplashScreen API — guarded by Build.VERSION check at runtime
import androidx.core.splashscreen.SplashScreen;

/**
 * MainActivity — hosts the WebView that runs the LastWave web app.
 *
 * ─── Last.fm Auth flow ───────────────────────────────────────────────────────
 * 1. JS calls  AndroidBridge.openAuthBrowser(url)
 *    → opens Chrome Custom Tab to https://www.last.fm/api/auth/?...&cb=lastwave://auth
 * 2. User approves on Last.fm → Last.fm redirects to lastwave://auth?token=TOKEN
 * 3. Android catches the deep link intent in onNewIntent()
 *    → calls JS window._lfmDeepLink(token)
 * 4. JS calls auth.getSession (signed), gets session key, stores it
 * 5. JS calls AndroidBridge.saveSessionKey(key) → SharedPreferences
 *
 * ─── Required AndroidManifest.xml additions ──────────────────────────────────
 *
 *   On the <activity> element, add:
 *     android:launchMode="singleTop"
 *
 *   Inside the <activity> element, add this intent-filter:
 *
 *     <intent-filter>
 *         <action android:name="android.intent.action.VIEW" />
 *         <category android:name="android.intent.category.DEFAULT" />
 *         <category android:name="android.intent.category.BROWSABLE" />
 *         <data android:scheme="lastwave" android:host="auth" />
 *     </intent-filter>
 *
 * ─── Required build.gradle dependency ────────────────────────────────────────
 *   implementation 'androidx.browser:browser:1.6.0'
 */
public class MainActivity extends AppCompatActivity {

    private WebView webView;
    private static final int  PERMISSION_REQUEST = 1001;
    private static final String PREFS_NAME       = "lastwave_prefs";
    private static final String PREF_SESSION_KEY = "lw_session_key";

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // ── Dismiss native Android 12+ splash immediately ──────────────────────
        // (if running on Android 12+, this will dismiss the native SplashScreen
        // that was shown by the theme. On older Android, this is a no-op.)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            SplashScreen.installSplashScreen(this).setOnExitAnimationListener(splashScreenView -> {
                splashScreenView.remove();
            });
        }

        super.onCreate(savedInstanceState);

        // ── Edge-to-edge: draw behind status bar and navigation bar ──────────
        // Bars are transparent; JS receives the real inset sizes via
        // window._applySystemInsets() and applies them as CSS variables.
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        getWindow().setStatusBarColor(Color.TRANSPARENT);
        getWindow().setNavigationBarColor(Color.TRANSPARENT);

        setContentView(R.layout.activity_main);

        webView = findViewById(R.id.webview);

        // ── Hardware acceleration — ensures the WebView compositor runs on
        // the GPU.  Critical for smooth canvas animations and 60fps touch.
        webView.setLayerType(View.LAYER_TYPE_HARDWARE, null);

        // ── System inset listener ─────────────────────────────────────────────
        // Reads the real top/bottom inset heights from the OS and passes them
        // to JS so the topbar and bottom nav can pad themselves correctly.
        ViewCompat.setOnApplyWindowInsetsListener(webView, (v, insets) -> {
            float density = getResources().getDisplayMetrics().density;
            int top    = Math.round(insets.getInsets(WindowInsetsCompat.Type.systemBars()).top    / density);
            int bottom = Math.round(insets.getInsets(WindowInsetsCompat.Type.systemBars()).bottom / density);
            // Deliver to JS — safe to call before page load; bridge.js
            // re-requests on DOMContentLoaded via AndroidBridge.getSystemInsets()
            webView.post(() -> webView.evaluateJavascript(
                "if(typeof window._applySystemInsets==='function')" +
                "  window._applySystemInsets(" + top + "," + bottom + ");", null));
            return insets;
        });
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        // Smooth scrolling and reduced overdraw
        settings.setLoadsImagesAutomatically(true);
        // Use hardware-accelerated rendering path for text
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
            settings.setDisabledActionModeMenuItems(WebSettings.MENU_ITEM_NONE);
        }
        // FIX: Removed setAllowFileAccessFromFileURLs(true) and
        // setAllowUniversalAccessFromFileURLs(true) — both deprecated and
        // unnecessary since WebViewAssetLoader serves from
        // https://appassets.androidplatform.net. Enabling them would allow
        // file:// URLs to make cross-origin requests, creating XSS risk.
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);

        // ── Disable WebView algorithmic dark mode ─────────────────────────────
        // Without this, Android 10+ WebView applies a system-level color
        // transformation pass to pseudo-elements (::after, ::before) that runs
        // BELOW the CSS cascade and ignores !important — causing the toggle
        // thumb and other white pseudo-elements to appear dark/grey in ON state.
        // API 29-32: setForceDark(OFF)
        // API 33+  : setAlgorithmicDarkeningAllowed(false)
        if (WebViewFeature.isFeatureSupported(WebViewFeature.FORCE_DARK)) {
            WebSettingsCompat.setForceDark(settings, WebSettingsCompat.FORCE_DARK_OFF);
        }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.ALGORITHMIC_DARKENING)) {
            WebSettingsCompat.setAlgorithmicDarkeningAllowed(settings, false);
        }
        // FIX: Removed MIXED_CONTENT_ALWAYS_ALLOW — redundant because
        // android:usesCleartextTraffic="false" already blocks HTTP at the OS
        // level, and the setting contradicts the manifest's intent.

        webView.setWebChromeClient(new WebChromeClient());
        // Disable remote debugging in all builds — never expose DevTools to the network
        WebView.setWebContentsDebuggingEnabled(false);

        final WebViewAssetLoader assetLoader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        webView.setWebViewClient(new WebViewClientCompat() {

            @Nullable
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return assetLoader.shouldInterceptRequest(request.getUrl());
            }

            @Nullable
            @Override
            @SuppressWarnings("deprecation")
            public WebResourceResponse shouldInterceptRequest(WebView view, String url) {
                return assetLoader.shouldInterceptRequest(android.net.Uri.parse(url));
            }
        });

        webView.loadUrl("https://appassets.androidplatform.net/assets/index.html");

        // ── Request runtime permissions ───────────────────────────────────────
        // On Android 13+, WRITE_EXTERNAL_STORAGE is not available; the app uses
        // MediaStore (API 29+) or the legacy paths (older devices). WRITE is only
        // requested on API < 29 for backwards compat.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
                && ContextCompat.checkSelfPermission(this, Manifest.permission.WRITE_EXTERNAL_STORAGE)
                != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this,
                    new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE},
                    PERMISSION_REQUEST);
        }

        // ── Back button handling ──────────────────────────────────────────────
        // Instead of calling WebView.goBack(), call JS window._lwHandleBack()
        // so that screens can intercept the back gesture (e.g., collapse panels).
        // The JS function decides whether to go back or take custom action.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                webView.evaluateJavascript("if(typeof window._lwHandleBack==='function') window._lwHandleBack();", null);
            }
        });

        // ── Setup JS Interface (Android <-> WebView bridge) ──────────────────
        webView.addJavascriptInterface(new JSBridge(), "AndroidBridge");
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        // ── Handle deep-link callback from Last.fm OAuth ──────────────────────
        // When Last.fm redirects to lastwave://auth?token=TOKEN, this is called.
        Uri data = intent.getData();
        if (data != null && "lastwave".equals(data.getScheme()) && "auth".equals(data.getHost())) {
            String token = data.getQueryParameter("token");
            if (token != null && !token.isEmpty()) {
                webView.evaluateJavascript(
                    "if(typeof window._lfmDeepLink==='function') window._lfmDeepLink('" + token.replace("'", "\\'") + "');",
                    null);
            }
        }
    }

    // ──────────────────────────────────────────────────────────────────────────
    //  JavaScript Interface (AndroidBridge)
    // ──────────────────────────────────────────────────────────────────────────
    private class JSBridge {

        // ── Permissions ───────────────────────────────────────────────────────

        /**
         * Checks if WRITE_EXTERNAL_STORAGE permission has been granted.
         * Used by screens to know whether to show "Save" actions.
         *
         * JS call: AndroidBridge.hasWritePermission()
         */
        @JavascriptInterface
        public boolean hasWritePermission() {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                return true; // API 29+ uses MediaStore, not filesystem permissions
            }
            return ContextCompat.checkSelfPermission(MainActivity.this,
                    Manifest.permission.WRITE_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED;
        }

        // ── Session key (Last.fm) ──────────────────────────────────────────────

        /**
         * Saves the Last.fm session key to persistent storage (SharedPreferences).
         * Called after user completes OAuth auth flow.
         *
         * JS call: AndroidBridge.saveSessionKey(sessionKey)
         */
        @JavascriptInterface
        public void saveSessionKey(String sessionKey) {
            SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
            prefs.edit().putString(PREF_SESSION_KEY, sessionKey).apply();
        }

        /**
         * Retrieves the saved Last.fm session key from SharedPreferences.
         * Called during app init to restore auth state.
         *
         * JS call: AndroidBridge.getSavedSessionKey()
         */
        @JavascriptInterface
        public String getSavedSessionKey() {
            SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
            return prefs.getString(PREF_SESSION_KEY, "");
        }

        /**
         * Clears the saved session key when user signs out.
         *
         * JS call: AndroidBridge.clearSessionKey()
         */
        @JavascriptInterface
        public void clearSessionKey() {
            SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
            prefs.edit().remove(PREF_SESSION_KEY).apply();
        }

        // ── OAuth browser launcher ─────────────────────────────────────────────

        /**
         * Opens the Last.fm OAuth authorization URL in Chrome Custom Tabs.
         * (Fallback to system browser on older devices without Custom Tabs.)
         *
         * URL format: https://www.last.fm/api/auth/?api_key=...&token=...&cb=lastwave://auth
         *
         * When user approves, Last.fm redirects to lastwave://auth?token=TOKEN.
         * Android's intent routing catches this, fires onNewIntent(),
         * which calls JS window._lfmDeepLink(token).
         *
         * JS call: AndroidBridge.openAuthBrowser(url)
         */
        @JavascriptInterface
        public void openAuthBrowser(final String url) {
            runOnUiThread(() -> {
                try {
                    CustomTabColorSchemeParams params = new CustomTabColorSchemeParams.Builder()
                            .setToolbarColor(0xFF0F0F0F)
                            .build();

                    CustomTabsIntent intent = new CustomTabsIntent.Builder()
                            .setDefaultColorSchemeParams(params)
                            .setShowTitle(true)
                            .build();

                    intent.launchUrl(MainActivity.this, android.net.Uri.parse(url));
                } catch (Exception e) {
                    openInBrowser(url); // Fallback to system browser
                }
            });
        }

        // ── System insets (safe area) ──────────────────────────────────────────

        /**
         * Returns system insets (top and bottom) for the device in device-independent pixels.
         * Used to position the top bar and bottom navigation outside of notches and gesture areas.
         *
         * Result: "{\"top\": <dp>, \"bottom\": <dp>}"
         *
         * JS call: AndroidBridge.getSystemInsets()
         */
        @JavascriptInterface
        public String getSystemInsets() {
            WindowInsetsCompat insets = ViewCompat.getRootWindowInsets(webView);
            if (insets == null) return "{\"top\": 0, \"bottom\": 0}";

            float density = getResources().getDisplayMetrics().density;
            int top    = Math.round(insets.getInsets(WindowInsetsCompat.Type.systemBars()).top    / density);
            int bottom = Math.round(insets.getInsets(WindowInsetsCompat.Type.systemBars()).bottom / density);
            return "{\"top\": " + top + ", \"bottom\": " + bottom + "}";
        }

        // ── Material You colors ────────────────────────────────────────────────

        /**
         * Returns the system Material You accent colors (primary, secondary, tertiary).
         * API 31+: uses WallpaperColors extracted from the wallpaper by the OS.
         * API 12+: uses the system-enforced Material You colors.
         * Older:   returns empty string (dynamic color unavailable).
         *
         * Result: "{\"primary\": \"#...\", \"secondary\": \"#...\", \"tertiary\": \"#...\"}"
         *
         * JS call: AndroidBridge.getMaterialYouColors()
         */
        @JavascriptInterface
        public String getMaterialYouColors() {
            try {
                // Android 12+ (API 31): uses system resource slots that Monet populates
                // directly from wallpaper. These are the SAME values that DynamicColor
                // / dynamicDarkColorScheme() uses — NOT the raw dominant wallpaper hues
                // from WallpaperManager which are pre-Monet colors.
                // palette directly from system resource slots. These are exactly what
                // DynamicColors / dynamicDarkColorScheme() uses — NOT the raw dominant
                // wallpaper hues from WallpaperManager which are pre-Monet colors.
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    int primary   = ContextCompat.getColor(MainActivity.this, android.R.color.system_accent1_400);
                    int secondary = ContextCompat.getColor(MainActivity.this, android.R.color.system_accent2_400);
                    int tertiary  = ContextCompat.getColor(MainActivity.this, android.R.color.system_accent3_400);
                    return "{\"primary\":\""   + colorToHex(primary)
                         + "\",\"secondary\":\"" + colorToHex(secondary)
                         + "\",\"tertiary\":\""  + colorToHex(tertiary) + "\"}";
                }
                // Android 8.1–11 (API 27–30): best available fallback via WallpaperColors.
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
                    WallpaperManager wm = WallpaperManager.getInstance(MainActivity.this);
                    WallpaperColors colors = wm.getWallpaperColors(WallpaperManager.FLAG_SYSTEM);
                    if (colors == null) return "";
                    String primary   = colorToHex(colors.getPrimaryColor().toArgb());
                    String secondary = colors.getSecondaryColor() != null
                            ? colorToHex(colors.getSecondaryColor().toArgb()) : primary;
                    String tertiary  = colors.getTertiaryColor()  != null
                            ? colorToHex(colors.getTertiaryColor().toArgb())  : secondary;
                    return "{\"primary\":\"" + primary + "\",\"secondary\":\"" + secondary
                         + "\",\"tertiary\":\"" + tertiary + "\"}";
                }
                return "";
            } catch (Exception e) { return ""; }
        }

        // ── File / Share ──────────────────────────────────────────────────────

        /**
         * Saves a file to the public Downloads folder and shows a toast.
         * API 29+ : uses MediaStore.Downloads (no permission needed).
         * API < 29: uses Environment.getExternalStoragePublicDirectory(DIRECTORY_DOWNLOADS)
         *           (WRITE_EXTERNAL_STORAGE permission requested at startup).
         *
         * JS call: AndroidBridge.saveFile(filename, content, mimeType)
         */
        @JavascriptInterface
        public void saveFile(String filename, String content, String mimeType) {
            // MediaStore.Downloads routes files by MIME type. Audio/video types
            // (e.g. audio/x-mpegurl for .m3u) get sent to Music instead of
            // Downloads. Normalise anything that isn't text or image so the file
            // always lands in Downloads; the file extension preserves the format.
            String safeMime = (mimeType != null
                    && (mimeType.startsWith("text/") || mimeType.startsWith("image/")))
                    ? mimeType
                    : "application/octet-stream";
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    // API 29+ — MediaStore, no permission needed
                    android.content.ContentValues values = new android.content.ContentValues();
                    values.put(android.provider.MediaStore.Downloads.DISPLAY_NAME, filename);
                    values.put(android.provider.MediaStore.Downloads.MIME_TYPE, safeMime);
                    values.put(android.provider.MediaStore.Downloads.RELATIVE_PATH, "Download/LastWave/");
                    values.put(android.provider.MediaStore.Downloads.IS_PENDING, 1);

                    android.content.ContentResolver resolver = getContentResolver();
                    android.net.Uri uri = resolver.insert(
                        android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);

                    if (uri == null) throw new IOException("MediaStore insert returned null");

                    try (java.io.OutputStream os = resolver.openOutputStream(uri)) {
                        if (os == null) throw new IOException("Could not open output stream");
                        os.write(content.getBytes(StandardCharsets.UTF_8));
                    }

                    values.clear();
                    values.put(android.provider.MediaStore.Downloads.IS_PENDING, 0);
                    resolver.update(uri, values, null, null);

                } else {
                    // API < 29 — public Downloads directory
                    File dir  = new File(
                            Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS),
                            "LastWave");
                    dir.mkdirs();
                    File file = new File(dir, filename);
                    try (OutputStreamWriter w = new OutputStreamWriter(new FileOutputStream(file), StandardCharsets.UTF_8)) {
                        w.write(content);
                    }
                }

                runOnUiThread(() -> Toast.makeText(MainActivity.this,
                    "Saved to Downloads: " + filename, Toast.LENGTH_SHORT).show());

            } catch (Exception e) {
                runOnUiThread(() -> Toast.makeText(MainActivity.this,
                    "Save failed: " + e.getMessage(), Toast.LENGTH_LONG).show());
            }
        }

        @JavascriptInterface
        public void shareText(String text, String subject) {
            runOnUiThread(() -> {
                Intent intent = new Intent(Intent.ACTION_SEND);
                intent.setType("text/plain");
                intent.putExtra(Intent.EXTRA_TEXT, text);
                intent.putExtra(Intent.EXTRA_SUBJECT, subject);
                startActivity(Intent.createChooser(intent, "Share Playlist"));
            });
        }

        @JavascriptInterface
        public void shareFileContent(String filename, String content, String mimeType) {
            try {
                File dir  = new File(getCacheDir(), "shared");
                dir.mkdirs();
                File file = new File(dir, filename);
                try (OutputStreamWriter w = new OutputStreamWriter(new FileOutputStream(file), StandardCharsets.UTF_8)) {
                    w.write(content);
                }
                shareFile(file, mimeType);
            } catch (Exception e) {
                runOnUiThread(() -> Toast.makeText(MainActivity.this, "Share failed: " + e.getMessage(), Toast.LENGTH_LONG).show());
            }
        }

        // ── Misc ──────────────────────────────────────────────────────────────

        /**
         * Opens a URL in the system browser.
         * Used by Platform.openBrowser() in bridge.js.
         *
         * JS call: AndroidBridge.openUrl(url)
         */
        @JavascriptInterface
        public void openUrl(final String url) {
            runOnUiThread(() -> openInBrowser(url));
        }

        @JavascriptInterface
        public void showToast(String message) {
            runOnUiThread(() -> Toast.makeText(MainActivity.this, message, Toast.LENGTH_SHORT).show());
        }

        @JavascriptInterface
        public String getAppVersion() {
            try { return getPackageManager().getPackageInfo(getPackageName(), 0).versionName; }
            catch (Exception e) { return "1.0.0"; }
        }
    }

    // ── File share helper ─────────────────────────────────────────────────────
    private void shareFile(File file, String mimeType) {
        runOnUiThread(() -> {
            try {
                Uri uri = FileProvider.getUriForFile(this, getPackageName() + ".provider", file);
                Intent intent = new Intent(Intent.ACTION_SEND);
                intent.setType(mimeType);
                intent.putExtra(Intent.EXTRA_STREAM, uri);
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                startActivity(Intent.createChooser(intent, "Share Playlist"));
            } catch (Exception e) {
                Toast.makeText(this, "Error sharing: " + e.getMessage(), Toast.LENGTH_LONG).show();
            }
        });
    }

    private void openInBrowser(String url) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
        } catch (Exception e) {
            Toast.makeText(this, "Could not open browser: " + e.getMessage(), Toast.LENGTH_SHORT).show();
        }
    }

    private String colorToHex(int color) {
        return String.format("#%06X", (0xFFFFFF & color));
    }
}