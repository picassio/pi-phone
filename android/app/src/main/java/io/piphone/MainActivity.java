package io.piphone;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.os.Build;
import android.os.PowerManager;
import android.provider.MediaStore;
import android.webkit.CookieManager;
import java.io.OutputStream;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageInstaller;
import android.net.Uri;
import android.os.Bundle;
import android.provider.Settings;
import android.text.Html;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.widget.Toast;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.RandomAccessFile;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * Starts PiService, shows its progress, and once the server answers, signs in with the owner token from
 * home/.pi-pocket/config.json and shows the web app (DESIGN.md section 2). Checks the latest release for an update
 * once per process, and when the web app asks (`window.PiPhoneApp.checkForUpdates()`); DESIGN.md section 5.
 */
public final class MainActivity extends Activity {

    private static final int FILE_CHOOSER = 1;
    private static final String BASE = "http://127.0.0.1:" + PiService.PORT;

    private WebView web;
    /** Android's speech recognizer for dictation (`web/android-speech.js`). */
    private Dictation dictation;
    private ValueCallback<Uri[]> pendingFiles;
    private volatile boolean loaded = false;
    /** Whether the app is in front: PiService notifies only when it is not. */
    static volatile boolean inFront = false;
    /** A session a notification asked to open, before the web app was there to open it. */
    private volatile int pendingSession = -1;
    /** One automatic check per process: the activity comes and goes, the process stays. */
    private static volatile boolean checked = false;

    /** Android's installer reports here: it asks the user first, then says how the install went. */
    private final BroadcastReceiver installStatus = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
            if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
                Intent confirm = intent.getParcelableExtra(Intent.EXTRA_INTENT);
                if (confirm != null) startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            } else if (status != PackageInstaller.STATUS_SUCCESS) {
                String message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE);
                alert("The update did not install", message == null ? "status " + status : message);
            }
        }
    };

    /** What the web app may ask of the shell. */
    private final class Bridge {
        @JavascriptInterface
        public void checkForUpdates() {
            runOnUiThread(() -> MainActivity.this.checkForUpdates(true));
        }

        /** Save a file the server sends (`url`, on its own address) to Downloads, with this page's sign-in. */
        @JavascriptInterface
        public void download(String url, String name) {
            if (!url.startsWith(BASE + "/")) throw new IllegalArgumentException("not this app's address: " + url);
            new Thread(() -> MainActivity.this.download(url, name), "pi-download").start();
        }

        @JavascriptInterface
        public boolean notificationsEnabled() {
            return getSystemService(NotificationManager.class).areNotificationsEnabled();
        }

        @JavascriptInterface
        public void openNotificationSettings() {
            runOnUiThread(() -> startActivity(new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                    .putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName())));
        }

        /** Whether Android leaves pi out of its battery optimisation: network and timers with the screen off. */
        @JavascriptInterface
        public boolean runsUnrestricted() {
            return ((PowerManager) getSystemService(POWER_SERVICE)).isIgnoringBatteryOptimizations(getPackageName());
        }

        @JavascriptInterface
        public void runUnrestricted() {
            runOnUiThread(() -> startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                    Uri.parse("package:" + getPackageName()))));
        }

        /** Whether Android has a speech recognizer for dictation. */
        @JavascriptInterface
        public boolean dictationAvailable() {
            return dictation.available();
        }

        /** Listen for one utterance in `language` (BCP 47); events go to `window.__piPhoneSpeech`. */
        @JavascriptInterface
        public void startDictation(String language) {
            runOnUiThread(() -> dictation.start(language));
        }

        @JavascriptInterface
        public void stopDictation() {
            runOnUiThread(() -> dictation.stop());
        }

        @JavascriptInterface
        public void abortDictation() {
            runOnUiThread(() -> dictation.abort());
        }

        /** Sign in again and show the app: after a restore, the owner's sign-in is the backup's. */
        @JavascriptInterface
        public void reload() {
            loaded = false;
            new Thread(MainActivity.this::waitForServer, "pi-wait").start();
        }
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        web = new WebView(this);
        web.setBackgroundColor(0xff1a1b26);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMediaPlaybackRequiresUserGesture(false);
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, android.webkit.WebResourceRequest request) {
                Uri url = request.getUrl();
                if (BASE.equals(url.getScheme() + "://" + url.getAuthority())) return false;
                startActivity(new Intent(Intent.ACTION_VIEW, url));
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (pendingFiles != null) pendingFiles.onReceiveValue(null);
                pendingFiles = callback;
                Intent intent = params.createIntent();
                intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
                startActivityForResult(intent, FILE_CHOOSER);
                return true;
            }
        });
        dictation = new Dictation(this, web);
        web.addJavascriptInterface(new Bridge(), "PiPhoneApp");
        setContentView(web);
        registerReceiver(installStatus, new IntentFilter(Updater.INSTALL_STATUS));
        status("Starting…", null);

        startForegroundService(new Intent(this, PiService.class));
        pendingSession = getIntent().getIntExtra(PiService.EXTRA_SESSION, -1);
        new Thread(this::waitForServer, "pi-wait").start();
    }

    /** A notification tapped while the app runs: its session, at once if the web app is there. */
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        int session = intent.getIntExtra(PiService.EXTRA_SESSION, -1);
        if (session < 0) return;
        if (loaded) {
            web.evaluateJavascript("import('/store.js').then((store) => store.navigate(" + session + "))", null);
        } else {
            pendingSession = session;
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        inFront = true;
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        if (requestCode == Dictation.PERMISSION_REQUEST) {
            dictation.permitted(results.length > 0 && results[0] == android.content.pm.PackageManager.PERMISSION_GRANTED);
            return;
        }
        super.onRequestPermissionsResult(requestCode, permissions, results);
    }

    @Override
    protected void onPause() {
        inFront = false;
        super.onPause();
    }

    private void waitForServer() {
        PiService.State last = null;
        while (!loaded) {
            PiService.State state = PiService.state();
            if (state == PiService.State.FAILED) {
                failure("The runtime failed", PiService.failure() + "\n\n" + logTail());
                return;
            }
            if (state != last) {
                last = state;
                if (state == PiService.State.INSTALLING) status("Unpacking the runtime…", "First start after an install or update; this takes a minute.");
                if (state == PiService.State.UPDATING) status("Updating…", "Swapping in the new version.");
                if (state == PiService.State.STARTING) status("Starting the server…", null);
            }
            if ((state == PiService.State.STARTING || state == PiService.State.RUNNING) && answers()) {
                PiService.markRunning();
                try {
                    int session = pendingSession;
                    pendingSession = -1;
                    String url = BASE + "/login?token=" + Uri.encode(PiService.ownerToken(this))
                            + (session < 0 ? "" : "&next=" + Uri.encode("/s/" + session));
                    loaded = true;
                    runOnUiThread(() -> web.loadUrl(url));
                    if (!checked) {
                        checked = true;
                        runOnUiThread(() -> checkForUpdates(false));
                    }
                } catch (Exception e) {
                    failure("Cannot sign in", e + "\n\n" + logTail());
                }
                return;
            }
            try {
                Thread.sleep(500);
            } catch (InterruptedException e) {
                return;
            }
        }
    }

    /** The server answers once the app is open; before that it says 503 ("starting"). */
    private static boolean answers() {
        try {
            HttpURLConnection connection = (HttpURLConnection) new URL(BASE + "/").openConnection();
            connection.setConnectTimeout(1000);
            connection.setReadTimeout(2000);
            connection.setInstanceFollowRedirects(false);
            int code = connection.getResponseCode();
            connection.disconnect();
            return code != 503;
        } catch (IOException e) {
            return false;
        }
    }

    /**
     * A file from the server, into Downloads (MediaStore, Android 10 and later), then a notification that opens it. The
     * server's refusal (too large, not a file) is shown as it says it.
     */
    @android.annotation.TargetApi(29)
    private void download(String url, String name) {
        try {
            if (Build.VERSION.SDK_INT < 29) throw new IOException("Saving to Downloads needs Android 10 or later.");
            HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
            String cookie = CookieManager.getInstance().getCookie(url);
            if (cookie == null) throw new IOException("This page is not signed in.");
            connection.setRequestProperty("Cookie", cookie);
            connection.setReadTimeout(120_000);
            int code = connection.getResponseCode();
            if (code != 200) {
                String said;
                try (InputStream error = connection.getErrorStream()) {
                    said = error == null ? "" : new JSONObject(PiService.readAll(error)).optString("error", "");
                }
                throw new IOException(said.isEmpty() ? "HTTP " + code : said);
            }
            String type = connection.getContentType() == null ? "application/octet-stream" : connection.getContentType();
            ContentResolver resolver = getContentResolver();
            ContentValues values = new ContentValues();
            values.put(MediaStore.Downloads.DISPLAY_NAME, name);
            values.put(MediaStore.Downloads.MIME_TYPE, type.split(";")[0].trim());
            values.put(MediaStore.Downloads.IS_PENDING, 1);
            Uri saved = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
            if (saved == null) throw new IOException("Android did not make the file in Downloads.");
            try (InputStream in = connection.getInputStream(); OutputStream out = resolver.openOutputStream(saved)) {
                byte[] buffer = new byte[64 * 1024];
                int read;
                while ((read = in.read(buffer)) >= 0) out.write(buffer, 0, read);
            }
            values.clear();
            values.put(MediaStore.Downloads.IS_PENDING, 0);
            resolver.update(saved, values, null, null);
            savedNotification(name, saved, type.split(";")[0].trim());
            runOnUiThread(() -> Toast.makeText(this, "Saved " + name + " to Downloads.", Toast.LENGTH_SHORT).show());
        } catch (Exception e) {
            runOnUiThread(() -> alert("Could not save " + name, e.getMessage() == null ? e.toString() : e.getMessage()));
        }
    }

    private void savedNotification(String name, Uri saved, String type) {
        NotificationManager manager = getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel(
                PiService.EVENTS_CHANNEL, "Sessions", NotificationManager.IMPORTANCE_DEFAULT));
        PendingIntent open = PendingIntent.getActivity(this, saved.hashCode(),
                new Intent(Intent.ACTION_VIEW).setDataAndType(saved, type).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION),
                PendingIntent.FLAG_IMMUTABLE);
        manager.notify(saved.hashCode(), new Notification.Builder(this, PiService.EVENTS_CHANNEL)
                .setContentTitle("Saved to Downloads")
                .setContentText(name)
                .setSmallIcon(android.R.drawable.stat_sys_download_done)
                .setContentIntent(open)
                .setAutoCancel(true)
                .build());
    }

    private String logTail() {
        File log = PiService.logFile(getFilesDir());
        try (RandomAccessFile file = new RandomAccessFile(log, "r")) {
            long start = Math.max(0, file.length() - 6000);
            byte[] bytes = new byte[(int) (file.length() - start)];
            file.seek(start);
            file.readFully(bytes);
            return new String(bytes, StandardCharsets.UTF_8);
        } catch (IOException e) {
            return "(no log: " + e + ")";
        }
    }

    /** The web app's colors (web/style.css, the pocket theme): this page shows before the server and its fonts are up. */
    private static final String STATUS_STYLE = "body{margin:0;padding:24px;background:#1a1b26;color:#a9b1d6;"
            + "font:15px/1.5 system-ui,sans-serif}h3{color:#c0caf5;font-weight:600;margin:0 0 12px}"
            + "p{margin:0;color:#a9b1d6}pre{white-space:pre-wrap;font:12px/1.45 monospace;background:#13141c;"
            + "color:#c0caf5;border-radius:8px;padding:12px;margin-top:16px}";

    /** Progress: a title and an optional note. */
    private void status(String title, String note) {
        page(title, note == null ? "" : "<p>" + Html.escapeHtml(note) + "</p>");
    }

    /** A failure: a title and what the log says. */
    private void failure(String title, String log) {
        page(title, "<pre>" + Html.escapeHtml(log) + "</pre>");
    }

    private void page(String title, String body) {
        String html = "<html><head><meta name='viewport' content='width=device-width,initial-scale=1'>"
                + "<style>" + STATUS_STYLE + "</style></head><body>"
                + "<h3>" + Html.escapeHtml(title) + "</h3>" + body + "</body></html>";
        runOnUiThread(() -> web.loadDataWithBaseURL(null, html, "text/html", "utf-8", null));
    }

    // ─── Updates ────────────────────────────────────────────────────────────

    private void checkForUpdates(boolean asked) {
        new Thread(() -> {
            try {
                Updater.Plan plan = Updater.check(this);
                runOnUiThread(() -> offer(plan, asked));
            } catch (Exception e) {
                Log.w("pi-phone", "update check failed", e);
                if (asked) runOnUiThread(() -> alert("Could not check for updates", e.toString()));
            }
        }, "pi-update-check").start();
    }

    private void offer(Updater.Plan plan, boolean asked) {
        if (plan.kind == Updater.Kind.NONE) {
            if (asked) Toast.makeText(this, "pi is up to date.", Toast.LENGTH_SHORT).show();
            return;
        }
        if (plan.kind == Updater.Kind.RUNTIME) {
            new AlertDialog.Builder(this)
                    .setTitle("Update available")
                    .setMessage("A new version of pi (" + plan.shortVersion() + ") is ready. Updating restarts the"
                            + " server for a few seconds; a run in progress continues after it.")
                    .setPositiveButton("Update now", (dialog, which) -> updateRuntime(plan))
                    .setNegativeButton("Later", null)
                    .show();
            return;
        }
        new AlertDialog.Builder(this)
                .setTitle("App update available")
                .setMessage("A new version of the pi app (" + plan.shortVersion() + ") needs installing. Your sessions"
                        + " and sign-ins stay.")
                .setPositiveButton("Install", (dialog, which) -> updateApk(plan))
                .setNegativeButton("Later", null)
                .show();
    }

    private void updateRuntime(Updater.Plan plan) {
        loaded = false;
        status("Downloading the update…", null);
        new Thread(() -> {
            try {
                File into = new File(getFilesDir(), "updates");
                File rootfs = plan.rootfs ? Updater.download(plan.manifest.getJSONObject("rootfs"), into, this::progress) : null;
                File runtime = plan.runtime ? Updater.download(plan.manifest.getJSONObject("runtime"), into, this::progress) : null;
                PiService.applyUpdate(this, new PiService.Update(
                        rootfs, plan.manifest.getString("rootfsVersion"),
                        runtime, plan.manifest.getString("runtimeVersion")));
                waitForServer();
            } catch (Exception e) {
                failure("The update failed", e + "\n\nThe version before it is still installed: close and open the app.");
            }
        }, "pi-update").start();
    }

    private void updateApk(Updater.Plan plan) {
        if (!getPackageManager().canRequestPackageInstalls()) {
            new AlertDialog.Builder(this)
                    .setTitle("Allow pi to install updates")
                    .setMessage("Turn on \"Allow from this source\" for pi, then come back and install the update.")
                    .setPositiveButton("Open settings", (dialog, which) -> startActivity(new Intent(
                            Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getPackageName()))))
                    .setNegativeButton("Later", null)
                    .show();
            return;
        }
        AlertDialog progress = new AlertDialog.Builder(this)
                .setTitle("Downloading the app update")
                .setMessage("Starting…")
                .setCancelable(false)
                .show();
        new Thread(() -> {
            try {
                File apk = Updater.download(plan.manifest.getJSONObject("apk"), new File(getCacheDir(), "updates"),
                        (name, done, total) -> runOnUiThread(() -> progress.setMessage(megabytes(done, total))));
                runOnUiThread(progress::dismiss);
                Updater.installApk(this, apk);
            } catch (Exception e) {
                runOnUiThread(() -> {
                    progress.dismiss();
                    alert("The update failed", e.toString());
                });
            }
        }, "pi-update").start();
    }

    private long lastProgress = 0;

    private void progress(String name, long done, long total) {
        long now = System.currentTimeMillis();
        if (now - lastProgress < 500 && done < total) return;
        lastProgress = now;
        status("Downloading the update…", name + ": " + megabytes(done, total));
    }

    private static String megabytes(long done, long total) {
        return String.format(java.util.Locale.ROOT, "%.1f of %.1f MB", done / 1e6, total / 1e6);
    }

    private void alert(String title, String message) {
        runOnUiThread(() -> new AlertDialog.Builder(this)
                .setTitle(title)
                .setMessage(message)
                .setPositiveButton("OK", null)
                .show());
    }

    @Override
    protected void onDestroy() {
        dictation.release();
        unregisterReceiver(installStatus);
        super.onDestroy();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode != FILE_CHOOSER || pendingFiles == null) {
            super.onActivityResult(requestCode, resultCode, data);
            return;
        }
        // Pickers that may return several files (the photo picker, always) put them in ClipData, even one; parseResult reads
        // only getData() and would drop them.
        Uri[] picked = null;
        if (resultCode == RESULT_OK && data != null && data.getClipData() != null && data.getClipData().getItemCount() > 0) {
            picked = new Uri[data.getClipData().getItemCount()];
            for (int i = 0; i < picked.length; i++) picked[i] = data.getClipData().getItemAt(i).getUri();
        } else {
            picked = WebChromeClient.FileChooserParams.parseResult(resultCode, data);
        }
        pendingFiles.onReceiveValue(picked);
        pendingFiles = null;
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else moveTaskToBack(true);
    }
}
