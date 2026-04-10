package com.lastwave.app;

import android.graphics.Color;
import android.Manifest;
import android.app.WallpaperManager;
import android.content.pm.ApplicationInfo;
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
import java.io.*;
import java.io.IOException;
import java.nio.charset.StandardCharsets;

// API 27+ only — guarded by Build.VERSION check at runtime
import android.app.WallpaperColors;

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
        // FIX: Removed MIXED_CONTENT_ALWAYS_ALLOW — redundant because
        // android:usesCleartextTraffic="false" already blocks HTTP at the OS
        // level, and the setting contradicts the manifest's intent.

        webView.setWebChromeClient(new WebChromeClient());

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
                return assetLoader.shouldInterceptRequest(Uri.parse(url));
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                boolean isDebug = (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
                if (isDebug) {
                    view.evaluateJavascript(
                        "(function(){" +
                        "  var s = document.createElement('script');" +
                        "  s.src = 'https://cdn.jsdelivr.net/npm/eruda';" +
                        "  s.onload = function(){ eruda.init(); };" +
                        "  document.head.appendChild(s);" +
                        "})()", null);
                }

                // Deliver any deep-link token that arrived before the page finished loading
                deliverPendingDeepLink();
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String url = request.getUrl().toString();
                if (url.startsWith("https://") || url.startsWith("http://")) {
                    if (!url.startsWith("https://appassets.androidplatform.net/")) {
                        openInBrowser(url);
                        return true;
                    }
                }
                return false;
            }
        });

        webView.addJavascriptInterface(new AppBridge(), "AndroidBridge");
        webView.loadUrl("https://appassets.androidplatform.net/assets/index.html");

        // Back button: delegate to the JS navigation stack first.
        // _lwHandleBack() returns true when JS handled it (screen pop),
        // or false when the stack is empty and the app should exit.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                webView.evaluateJavascript(
                    "window._lwHandleBack ? String(window._lwHandleBack()) : 'false'",
                    result -> {
                        // result is a JSON string — "true" or "false"
                        if (!"true".equals(result)) {
                            // JS has nothing to go back to — exit normally
                            setEnabled(false);
                            getOnBackPressedDispatcher().onBackPressed();
                        }
                    }
                );
            }
        });

        requestPermissionsIfNeeded();

        // Handle deep link that may have launched the app cold (not via onNewIntent)
        handleIntent(getIntent());
    }

    // ── Deep link: app already running (singleTop) ────────────────────────────
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIntent(intent);
    }

    /**
     * Holds a token that arrived before the page finished loading.
     * Delivered to JS in onPageFinished().
     */
    private String pendingDeepLinkToken = null;

    private void handleIntent(Intent intent) {
        if (intent == null) return;
        Uri data = intent.getData();
        if (data == null) return;

        // Matches  lastwave://auth?token=TOKEN
        if ("lastwave".equalsIgnoreCase(data.getScheme())
                && "auth".equalsIgnoreCase(data.getHost())) {
            String token = data.getQueryParameter("token");
            if (token == null || token.isEmpty()) return;

            // Try to deliver immediately; if the page isn't ready yet, buffer it.
            if (!deliverDeepLinkToken(token)) {
                pendingDeepLinkToken = token;
            }
        }
    }

    /**
     * Calls window._lfmDeepLink(token) in the WebView.
     * @return true if the call was dispatched, false if the WebView wasn't ready.
     */
    private boolean deliverDeepLinkToken(String token) {
        if (webView == null) return false;
        // Escape the token (alphanumeric only from Last.fm, but be safe)
        final String safeToken = token.replaceAll("[^a-zA-Z0-9_\\-]", "");
        final String js = "if(typeof window._lfmDeepLink==='function'){window._lfmDeepLink('" + safeToken + "');}";
        webView.post(() -> webView.evaluateJavascript(js, null));
        return true;
    }

    /** Called from onPageFinished — flushes any buffered deep-link token. */
    private void deliverPendingDeepLink() {
        if (pendingDeepLinkToken != null) {
            deliverDeepLinkToken(pendingDeepLinkToken);
            pendingDeepLinkToken = null;
        }
    }

    // ── Shared helpers ────────────────────────────────────────────────────────
    private void openInBrowser(String url) {
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            startActivity(intent);
        } catch (Exception e) {
            Toast.makeText(this, "Cannot open URL", Toast.LENGTH_SHORT).show();
        }
    }

    private static String colorToHex(int colorInt) {
        return String.format("#%06X", (0xFFFFFF & colorInt));
    }

    private void requestPermissionsIfNeeded() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.WRITE_EXTERNAL_STORAGE)
                    != PackageManager.PERMISSION_GRANTED) {
                ActivityCompat.requestPermissions(this,
                        new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE}, PERMISSION_REQUEST);
            }
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  Android ↔ JavaScript Bridge
    // ══════════════════════════════════════════════════════════════════════════
    private class AppBridge {

        /**
         * Returns current system bar insets as JSON so JS can request them
         * on page load in case the listener fired before the page was ready.
         * Returns {"top":N,"bottom":N} in dp (CSS pixels).
         *
         * JS call: AndroidBridge.getSystemInsets()
         */
        @JavascriptInterface
        public String getSystemInsets() {
            androidx.core.view.WindowInsetsCompat insets =
                androidx.core.view.ViewCompat.getRootWindowInsets(webView);
            if (insets == null) return "{\"top\":0,\"bottom\":0}";
            float density = getResources().getDisplayMetrics().density;
            int top    = Math.round(insets.getInsets(WindowInsetsCompat.Type.systemBars()).top    / density);
            int bottom = Math.round(insets.getInsets(WindowInsetsCompat.Type.systemBars()).bottom / density);
            return "{\"top\":" + top + ",\"bottom\":" + bottom + "}";
        }

        // ── Auth: open Last.fm authorization page ────────────────────────────
        /**
         * Opens the Last.fm auth URL in Chrome Custom Tabs (preferred) or the
         * system browser. Never uses the in-app WebView so the user's real
         * browser cookies / saved password are available.
         *
         * JS call: AndroidBridge.openAuthBrowser(url)
         */
        @JavascriptInterface
        public void openAuthBrowser(final String url) {
            runOnUiThread(() -> {
                try {
                    // Attempt Chrome Custom Tabs first
                    CustomTabColorSchemeParams darkParams = new CustomTabColorSchemeParams.Builder()
                            .setToolbarColor(Color.parseColor("#0F0F0F"))
                            .build();

                    CustomTabsIntent customTabsIntent = new CustomTabsIntent.Builder()
                            .setColorSchemeParams(CustomTabsIntent.COLOR_SCHEME_DARK, darkParams)
                            .setShowTitle(true)
                            .build();
                    customTabsIntent.launchUrl(MainActivity.this, Uri.parse(url));
                } catch (Exception e) {
                    // Fallback: plain system browser intent
                    try {
                        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
                        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                        startActivity(intent);
                    } catch (Exception e2) {
                        runOnUiThread(() -> Toast.makeText(MainActivity.this,
                                "Could not open browser", Toast.LENGTH_LONG).show());
                    }
                }
            });
        }

        // ── Auth: session key persistence ─────────────────────────────────────

        /**
         * Returns the saved Last.fm session key from SharedPreferences.
         * Returns "" if none is stored.
         *
         * JS call: AndroidBridge.getSavedSessionKey()
         */
        @JavascriptInterface
        public String getSavedSessionKey() {
            SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
            return prefs.getString(PREF_SESSION_KEY, "");
        }

        /**
         * Persists the Last.fm session key to SharedPreferences.
         *
         * JS call: AndroidBridge.saveSessionKey(key)
         */
        @JavascriptInterface
        public void saveSessionKey(String key) {
            if (key == null || key.trim().isEmpty()) return;
            getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
                    .edit()
                    .putString(PREF_SESSION_KEY, key.trim())
                    .apply();
        }

        /**
         * Clears the stored session key (sign-out).
         *
         * JS call: AndroidBridge.clearSession()
         */
        @JavascriptInterface
        public void clearSession() {
            getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
                    .edit()
                    .remove(PREF_SESSION_KEY)
                    .apply();
        }

        // ── Wallpaper Colors ──────────────────────────────────────────────────
        @JavascriptInterface
        public String getWallpaperColors() {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O_MR1) return "";
            try {
                WallpaperManager wm = WallpaperManager.getInstance(MainActivity.this);
                WallpaperColors colors = wm.getWallpaperColors(WallpaperManager.FLAG_SYSTEM);
                if (colors == null) return "";
                String primary   = colorToHex(colors.getPrimaryColor().toArgb());
                String secondary = colors.getSecondaryColor() != null ? colorToHex(colors.getSecondaryColor().toArgb()) : primary;
                String tertiary  = colors.getTertiaryColor()  != null ? colorToHex(colors.getTertiaryColor().toArgb())  : secondary;
                return "{\"primary\":\"" + primary + "\",\"secondary\":\"" + secondary + "\",\"tertiary\":\"" + tertiary + "\"}";
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
}
