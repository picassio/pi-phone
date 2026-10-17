package io.piphone;

import android.app.Activity;
import android.app.AlertDialog;
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
    private ValueCallback<Uri[]> pendingFiles;
    private volatile boolean loaded = false;
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
        web.addJavascriptInterface(new Bridge(), "PiPhoneApp");
        setContentView(web);
        registerReceiver(installStatus, new IntentFilter(Updater.INSTALL_STATUS));
        status("Starting…", null);

        startForegroundService(new Intent(this, PiService.class));
        new Thread(this::waitForServer, "pi-wait").start();
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
                    String url = BASE + "/login?token=" + Uri.encode(ownerToken());
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

    private String ownerToken() throws Exception {
        File config = new File(getFilesDir(), "home/.pi-pocket/config.json");
        try (InputStream in = new FileInputStream(config)) {
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int read;
            while ((read = in.read(buffer)) >= 0) out.write(buffer, 0, read);
            return new JSONObject(out.toString("UTF-8")).getString("ownerToken");
        }
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
        unregisterReceiver(installStatus);
        super.onDestroy();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode != FILE_CHOOSER || pendingFiles == null) {
            super.onActivityResult(requestCode, resultCode, data);
            return;
        }
        pendingFiles.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
        pendingFiles = null;
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else moveTaskToBack(true);
    }
}
