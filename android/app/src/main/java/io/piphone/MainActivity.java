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
import android.view.InputDevice;
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

import org.json.JSONException;
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
                alert(getString(R.string.update_not_installed), message == null ? "status " + status : message);
            }
        }
    };

    /** What the web app may ask of the shell. */
    private final class Bridge {
        /** Sign in again with the owner token as config.json has it now: after the owner signed out every device. */
        @JavascriptInterface
        public void signIn() {
            try {
                String url = BASE + "/login?token=" + Uri.encode(PiService.ownerToken(MainActivity.this));
                runOnUiThread(() -> web.loadUrl(url));
            } catch (Exception e) {
                runOnUiThread(() -> failure(getString(R.string.cannot_sign_in), e.toString()));
            }
        }

        @JavascriptInterface
        public void checkForUpdates() {
            runOnUiThread(() -> MainActivity.this.checkForUpdates(true));
        }

        /**
         * Whether a physical keyboard with letters is connected (a Bluetooth or USB one): then Enter sends in the message
         * box (GitHub issue #2). Some input methods (Sogou) pass its plain Enter on as the on-screen keyboard's, with no
         * `KeyboardEvent.code`, so the page cannot tell from the key itself.
         */
        @JavascriptInterface
        public boolean hardKeyboard() {
            for (int id : InputDevice.getDeviceIds()) {
                InputDevice device = InputDevice.getDevice(id);

                if (device == null || device.isVirtual() || device.getKeyboardType() != InputDevice.KEYBOARD_TYPE_ALPHABETIC) {
                    continue;
                }

                // A phone's own buttons are never alphabetic, but some report so: only one plugged in or paired counts.
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q || device.isExternal()) {
                    return true;
                }
            }

            return false;
        }

        /** The update found and not yet taken or put off, as `sheets/update.js` shows it; "" for none. */
        @JavascriptInterface
        public String pendingUpdate() {
            Updater.Plan plan = offered;
            return plan == null ? "" : offerJson(plan);
        }

        /** Update now (or Install): the offer the sheet showed. */
        @JavascriptInterface
        public void applyUpdate() {
            runOnUiThread(() -> {
                Updater.Plan plan = offered;
                offered = null;
                if (plan == null) return;
                if (plan.kind == Updater.Kind.RUNTIME) updateRuntime(plan);
                else updateApk(plan);
            });
        }

        /** Later. */
        @JavascriptInterface
        public void dismissUpdate() {
            offered = null;
        }

        /** Android's "Allow from this source" for pi-phone, which installing an app update needs. */
        @JavascriptInterface
        public void openInstallSettings() {
            runOnUiThread(() -> startActivity(new Intent(
                    Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getPackageName()))));
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

        /**
         * Android's settings pages that setting up phone control needs (Menu › Phone control, PP-141): `app-info` (pi's
         * App info, whose ⋮ menu has Allow restricted settings on Android 13+), `accessibility`, `battery`.
         */
        @JavascriptInterface
        public void openSettings(String which) {
            Intent intent;
            if ("app-info".equals(which)) {
                intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getPackageName()));
            } else if ("accessibility".equals(which)) {
                intent = new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS);
            } else if ("battery".equals(which)) {
                intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + getPackageName()));
            } else {
                throw new IllegalArgumentException("no settings page " + which);
            }
            runOnUiThread(() -> startActivity(intent));
        }

        /** Whether pi-phone's accessibility service is on (connected now). */
        @JavascriptInterface
        public boolean phoneControlOn() {
            return PiAccessibility.get() != null;
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
        status(getString(R.string.starting), null);

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
                failure(getString(R.string.runtime_failed), PiService.failure() + "\n\n" + logTail());
                return;
            }
            if (state != last) {
                last = state;
                if (state == PiService.State.INSTALLING) status(getString(R.string.unpacking), getString(R.string.unpacking_note));
                if (state == PiService.State.UPDATING) status(getString(R.string.updating), getString(R.string.updating_note));
                if (state == PiService.State.STARTING) status(getString(R.string.starting_server), null);
            }
            if ((state == PiService.State.STARTING || state == PiService.State.RUNNING) && answers()) {
                PiService.markRunning();
                try {
                    int session = pendingSession;
                    pendingSession = -1;
                    String url = BASE + "/login?token=" + Uri.encode(PiService.ownerToken(this))
                            + (session < 0 ? "" : "&next=" + Uri.encode("/s/" + session));
                    loaded = true;
                    statusShown = false;
                    runOnUiThread(() -> web.loadUrl(url));
                    if (!checked) {
                        checked = true;
                        runOnUiThread(() -> checkForUpdates(false));
                    }
                } catch (Exception e) {
                    failure(getString(R.string.cannot_sign_in), e + "\n\n" + logTail());
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
            if (Build.VERSION.SDK_INT < 29) throw new IOException(getString(R.string.downloads_need_android_10));
            HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
            String cookie = CookieManager.getInstance().getCookie(url);
            if (cookie == null) throw new IOException(getString(R.string.page_not_signed_in));
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
            if (saved == null) throw new IOException(getString(R.string.downloads_no_file));
            try (InputStream in = connection.getInputStream(); OutputStream out = resolver.openOutputStream(saved)) {
                byte[] buffer = new byte[64 * 1024];
                int read;
                while ((read = in.read(buffer)) >= 0) out.write(buffer, 0, read);
            }
            values.clear();
            values.put(MediaStore.Downloads.IS_PENDING, 0);
            resolver.update(saved, values, null, null);
            savedNotification(name, saved, type.split(";")[0].trim());
            runOnUiThread(() -> Toast.makeText(this, getString(R.string.saved_name_to_downloads, name), Toast.LENGTH_SHORT).show());
        } catch (Exception e) {
            runOnUiThread(() -> alert(getString(R.string.could_not_save, name), e.getMessage() == null ? e.toString() : e.getMessage()));
        }
    }

    private void savedNotification(String name, Uri saved, String type) {
        NotificationManager manager = getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel(
                PiService.EVENTS_CHANNEL, getString(R.string.channel_sessions), NotificationManager.IMPORTANCE_DEFAULT));
        PendingIntent open = PendingIntent.getActivity(this, saved.hashCode(),
                new Intent(Intent.ACTION_VIEW).setDataAndType(saved, type).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION),
                PendingIntent.FLAG_IMMUTABLE);
        manager.notify(saved.hashCode(), new Notification.Builder(this, PiService.EVENTS_CHANNEL)
                .setContentTitle(getString(R.string.saved_to_downloads))
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
    /**
     * The app's own screen before the server answers (unpacking, updating, starting, downloading an update) and when
     * something failed: the logo, the app's name, a spinner, what is happening and a note, a progress bar for a download,
     * and the log for a failure. It loads once; `show()` then changes it in place, so the spinner keeps turning.
     */
    private static final String STATUS_PAGE = "<!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'>"
            + "<style>"
            + "html,body{margin:0;height:100%;background:#141414;color:#a9b1d6;font:15px/1.5 system-ui,-apple-system,Roboto,sans-serif}"
            + "main{min-height:100%;box-sizing:border-box;display:flex;flex-direction:column;align-items:center;justify-content:center;"
            + "padding:32px 28px;text-align:center}"
            + ".logo{width:72px;height:72px}"
            + ".name{margin:18px 0 28px;color:#e8eaf2;font-size:22px;font-weight:600;letter-spacing:-.01em}"
            + ".spin{width:22px;height:22px;border-radius:50%;border:2.5px solid rgba(169,177,214,.18);border-top-color:#a9b1d6;"
            + "animation:spin .9s linear infinite;margin-bottom:22px}"
            + "@keyframes spin{to{transform:rotate(360deg)}}"
            + ".title{color:#d4d8e8;font-size:16px;font-weight:500}"
            + ".note{margin-top:6px;color:#7b8199;font-size:13.5px;max-width:30em}"
            + ".bar{width:min(280px,80%);height:4px;margin:20px 0 8px;border-radius:2px;background:rgba(169,177,214,.15);overflow:hidden}"
            + ".bar i{display:block;height:100%;width:0;border-radius:2px;background:#7aa2f7;transition:width .4s ease}"
            + ".amount{color:#7b8199;font-size:12.5px;font-variant-numeric:tabular-nums}"
            + "pre{align-self:stretch;text-align:left;white-space:pre-wrap;font:12px/1.45 monospace;background:#0d0d10;color:#c0caf5;"
            + "border-radius:10px;padding:12px;margin:22px 0 0;max-height:55vh;overflow:auto}"
            + "body.failed main{justify-content:flex-start;padding-top:56px}body.failed .title{color:#f7768e}"
            + "[hidden]{display:none!important}"
            + "</style></head><body><main>"
            + "<svg class='logo' viewBox='150 150 500 500' aria-hidden='true'>"
            + "<path fill='#F09082' d='M165.29 165.29H517.36V400H400V282.65H165.29Z'/>"
            + "<path fill='#4D9ABF' d='M165.29 282.65H282.65V400H400V517.36H282.65V634.72H165.29Z'/>"
            + "<path fill='#F1BE58' d='M517.36 400H634.72V634.72H517.36Z'/></svg>"
            + "<div class='name'>pi-phone</div>"
            + "<div class='spin' id='spin'></div>"
            + "<div class='title' id='title'></div><div class='note' id='note'></div>"
            + "<div class='bar' id='bar' hidden><i id='fill'></i></div><div class='amount' id='amount'></div>"
            + "<pre id='log' hidden></pre>"
            + "</main><script>"
            + "function show(s){title.textContent=s.title||'';note.textContent=s.note||'';note.hidden=!s.note;"
            + "spin.hidden=!!s.failed;bar.hidden=s.fraction==null;if(s.fraction!=null)fill.style.width=Math.round(s.fraction*100)+'%';"
            + "amount.textContent=s.amount||'';log.hidden=!s.log;log.textContent=s.log||'';document.body.classList.toggle('failed',!!s.failed)}"
            + "</script>";

    /** Whether the status screen is what the WebView shows now (the app's page replaces it once the server answers). */
    private volatile boolean statusShown = false;

    /** Show the status screen as `state` says: loaded the first time, changed in place after. */
    private void show(JSONObject state) {
        runOnUiThread(() -> {
            if (statusShown) {
                web.evaluateJavascript("typeof show==='function'&&show(" + state + ")", null);
            } else {
                statusShown = true;
                web.loadDataWithBaseURL(null, STATUS_PAGE + "<script>show(" + state + ")</script></body></html>", "text/html", "utf-8", null);
            }
        });
    }

    /** Progress: what is happening, and an optional note. */
    private void status(String title, String note) {
        try {
            show(new JSONObject().put("title", title).put("note", note == null ? "" : note));
        } catch (JSONException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    /** A download: what it is, how far, as a bar and in megabytes. */
    private void downloading(String title, String note, long done, long total) {
        try {
            show(new JSONObject().put("title", title).put("note", note).put("fraction", total > 0 ? Math.min(1.0, (double) done / total) : 0)
                    .put("amount", megabytes(done, total)));
        } catch (JSONException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    /** A failure: what failed, and what the log says. */
    private void failure(String title, String log) {
        try {
            show(new JSONObject().put("title", title).put("log", log).put("failed", true));
        } catch (JSONException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    // ─── Updates ────────────────────────────────────────────────────────────

    private void checkForUpdates(boolean asked) {
        new Thread(() -> {
            try {
                Updater.Plan plan = Updater.check(this);
                runOnUiThread(() -> offer(plan, asked));
            } catch (Exception e) {
                Log.w("pi-phone", "update check failed", e);
                if (asked) runOnUiThread(() -> alert(getString(R.string.could_not_check_updates), e.toString()));
            }
        }, "pi-update-check").start();
    }

    private void offer(Updater.Plan plan, boolean asked) {
        if (plan.kind == Updater.Kind.NONE) {
            if (asked) Toast.makeText(this, getString(R.string.up_to_date), Toast.LENGTH_SHORT).show();
            return;
        }
        // Offered in the web app's own sheet (web/sheets/update.js): handed over now, and kept for a page that starts
        // later (it asks with pendingUpdate()).
        offered = plan;
        web.evaluateJavascript("globalThis.__piPhoneUpdate && globalThis.__piPhoneUpdate(" + offerJson(plan) + ")", null);
    }

    /** The update found and not yet taken or put off. */
    private volatile Updater.Plan offered;

    private String offerJson(Updater.Plan plan) {
        try {
            return new JSONObject()
                    .put("kind", plan.kind == Updater.Kind.RUNTIME ? "runtime" : "apk")
                    .put("version", plan.shortVersion())
                    .put("canInstall", getPackageManager().canRequestPackageInstalls())
                    .toString();
        } catch (JSONException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    private void updateRuntime(Updater.Plan plan) {
        loaded = false;
        downloading(getString(R.string.downloading_update), "", 0, 0);
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
                failure(getString(R.string.update_failed), getString(R.string.update_failed_note, e.toString()));
            }
        }, "pi-update").start();
    }

    private void updateApk(Updater.Plan plan) {
        if (!getPackageManager().canRequestPackageInstalls()) {
            new AlertDialog.Builder(this)
                    .setTitle(getString(R.string.allow_installs_title))
                    .setMessage(getString(R.string.allow_installs_message))
                    .setPositiveButton(getString(R.string.open_settings), (dialog, which) -> startActivity(new Intent(
                            Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getPackageName()))))
                    .setNegativeButton(getString(R.string.later), null)
                    .show();
            return;
        }
        // The status screen, with a bar, while the APK downloads; then Android's installer, over the app again.
        loaded = false;
        String version = getString(R.string.version, plan.shortVersion());
        downloading(getString(R.string.downloading_app_update), version, 0, 0);
        new Thread(() -> {
            try {
                File apk = Updater.download(plan.manifest.getJSONObject("apk"), new File(getCacheDir(), "updates"),
                        (name, done, total) -> {
                            long now = System.currentTimeMillis();
                            if (now - lastProgress < 250 && done < total) return;
                            lastProgress = now;
                            downloading(getString(R.string.downloading_app_update), version, done, total);
                        });
                status(getString(R.string.installing_update), getString(R.string.installing_update_note));
                Updater.installApk(this, apk);
            } catch (Exception e) {
                alert(getString(R.string.update_failed), e.toString());
            }
            waitForServer();
        }, "pi-update").start();
    }

    private long lastProgress = 0;

    private void progress(String name, long done, long total) {
        long now = System.currentTimeMillis();
        if (now - lastProgress < 500 && done < total) return;
        lastProgress = now;
        downloading(getString(R.string.downloading_update), name, done, total);
    }

    private String megabytes(long done, long total) {
        return String.format(java.util.Locale.ROOT, getString(R.string.megabytes), done / 1e6, total / 1e6);
    }

    private void alert(String title, String message) {
        runOnUiThread(() -> new AlertDialog.Builder(this)
                .setTitle(title)
                .setMessage(message)
                .setPositiveButton(getString(R.string.ok), null)
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
