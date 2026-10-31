package io.piphone;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.os.Build;
import android.os.PowerManager;
import android.view.InputDevice;
import android.view.KeyEvent;
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
import android.webkit.PermissionRequest;
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
    /** Android's answer to the microphone for the page's call (`onPermissionRequest`). */
    private static final int MIC_FOR_PAGE = 8;
    private static final String BASE = "http://127.0.0.1:" + PiService.PORT;
    /** The voice call's notification, tapped: show the call of this session (PP-191). */
    static final String EXTRA_VOICE_SHOW = "io.piphone.VOICE_SHOW";
    /** The assistant's sheet hands its call over (PP-192): start a call in this session here. */
    static final String EXTRA_VOICE_START = "io.piphone.VOICE_START";
    /** With `EXTRA_VOICE_START`: once the call is up, go back to the app that was in front. */
    static final String EXTRA_VOICE_BACK = "io.piphone.VOICE_BACK";

    private WebView web;
    /** Android's speech recognizer for dictation (`web/android-speech.js`). */
    private Dictation dictation;
    /** Android's text-to-speech: the device's voice for "Pi thinks" (PP-193). */
    private Speech speech;
    private ValueCallback<Uri[]> pendingFiles;
    private volatile boolean loaded = false;
    /** Whether the app is in front: PiService notifies only when it is not. */
    static volatile boolean inFront = false;
    /**
     * The app's window has the focus: the person is using pi-phone now. On a big or folding screen, with another app
     * beside it, the app stays resumed (inFront) while the person uses the other: the floating board's bubble hides only
     * on this (PP-283).
     */
    static volatile boolean focused = false;
    /** A session a notification asked to open, before the web app was there to open it. */
    private volatile int pendingSession = -1;
    /** Menu › Assistant, asked by the assistant's sheet (to allow the microphone) before the web app was there. */
    private volatile boolean pendingAssistantSheet = false;
    /** A call to start or show (`EXTRA_VOICE_*`) before the web app was there: its session and what to do. */
    private volatile int pendingVoice = -1;
    private volatile String pendingVoiceWhat = "show";
    /** Go back to the app that was in front once the handed-over call is up. */
    private volatile boolean backAfterCall = false;
    /** The page's request for the microphone, while Android asks the person. */
    private PermissionRequest pendingMic;
    /** The call's notification buttons, to this window's page while its call runs (`VoiceCallService.page`). */
    private final java.util.function.Consumer<String> callPage =
            (action) -> web.post(() -> web.evaluateJavascript(VoicePage.action(action), null));
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
                runOnUiThread(() -> failure(getString(R.string.cannot_sign_in), e.toString(), false));
            }
        }

        /** The failure screen's Copy log (`assets/status.html`). */
        @JavascriptInterface
        public void copyLog() {
            MainActivity.this.copyLog();
        }

        /** The failure screen's Share log: off the page's thread, as it copies up to 4 MB. */
        @JavascriptInterface
        public void shareLog() {
            new Thread(MainActivity.this::shareLog, "pi-share-log").start();
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

        /** Whether Android lets pi display over other apps: the floating progress board's bubble (PP-283). */
        @JavascriptInterface
        public boolean overlayAllowed() {
            return Settings.canDrawOverlays(MainActivity.this);
        }

        /** Android's Display over other apps page for pi: the owner allows the bubble there, once. */
        @JavascriptInterface
        public void askOverlay() {
            runOnUiThread(() -> startActivity(new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                    Uri.parse("package:" + getPackageName()))));
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
            } else if ("assistant".equals(which)) {
                // Default apps, where Digital assistant app is (Menu › Assistant, PP-146): the same on every phone.
                intent = new Intent(Settings.ACTION_MANAGE_DEFAULT_APPS_SETTINGS);
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

        /** Whether pi-phone is the phone's digital assistant (Menu › Assistant, PP-146). */
        @JavascriptInterface
        public boolean assistantHeld() {
            return PiAssistant.held(MainActivity.this);
        }

        /** Whether the microphone is allowed: the assistant's sheet cannot ask for it, this window can. */
        @JavascriptInterface
        public boolean micAllowed() {
            return dictation.micAllowed();
        }

        /** Ask Android for the microphone now (Menu › Assistant's step), not at the first dictation. */
        @JavascriptInterface
        public void askMic() {
            runOnUiThread(() -> requestPermissions(new String[] {android.Manifest.permission.RECORD_AUDIO}, Dictation.PERMISSION_REQUEST));
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

        /**
         * The page's voice call started, changed, or ended (`web/voice-call.js`, PP-191): the call's notification and audio
         * follow (`VoiceCallService`), and its buttons come back here. While a call runs, the page's renderer keeps its
         * priority with the window hidden (the screen off, another app in front).
         */
        @JavascriptInterface
        public void voiceCall(String json) {
            runOnUiThread(() -> {
                try {
                    String state = VoicePage.tell(MainActivity.this, json);
                    if ("start".equals(state)) {
                        VoiceCallService.page = callPage;
                        web.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
                        if (backAfterCall) {
                            backAfterCall = false;
                            moveTaskToBack(true);
                        }
                    } else if ("end".equals(state)) {
                        web.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, true);
                    }
                } catch (JSONException e) {
                    Log.w("pi-phone", "voice call: " + e);
                }
            });
        }

        /** Whether the phone has a voice to read Pi's words with ("Pi thinks", reader "device"). */
        @JavascriptInterface
        public boolean speakAvailable() {
            return speech.available();
        }

        /** Read `text` out after what is being read; how it went goes to `window.__piPhoneSpoken`. */
        @JavascriptInterface
        public void speak(String id, String text, String language) {
            runOnUiThread(() -> speech.speak(id, text, language));
        }

        @JavascriptInterface
        public void stopSpeaking() {
            runOnUiThread(() -> speech.stop());
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
            /**
             * The microphone for a voice call or Codex dictation (PP-191): only the app's own page, only audio, and only once
             * Android allows pi the microphone (asked now, the first time).
             */
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                if (!VoicePage.ownAudio(request)) {
                    request.deny();
                    return;
                }
                if (dictation.micAllowed()) {
                    request.grant(new String[] {PermissionRequest.RESOURCE_AUDIO_CAPTURE});
                    return;
                }
                if (pendingMic != null) pendingMic.deny();
                pendingMic = request;
                requestPermissions(new String[] {android.Manifest.permission.RECORD_AUDIO}, MIC_FOR_PAGE);
            }

            @Override
            public void onPermissionRequestCanceled(PermissionRequest request) {
                if (pendingMic == request) pendingMic = null;
            }

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
        dictation = new Dictation(this, this, web);
        speech = new Speech(this, web);
        web.addJavascriptInterface(new Bridge(), "PiPhoneApp");
        setContentView(web);
        registerReceiver(installStatus, new IntentFilter(Updater.INSTALL_STATUS));
        status(getString(R.string.starting), null);

        startForegroundService(new Intent(this, PiService.class));
        pendingSession = getIntent().getIntExtra(PiService.EXTRA_SESSION, -1);
        pendingAssistantSheet = getIntent().getBooleanExtra(PiAssistantSession.EXTRA_ASSISTANT_SHEET, false);
        voiceIntent(getIntent());
        new Thread(this::waitForServer, "pi-wait").start();
    }

    /**
     * A call to start (the assistant's sheet handed it over) or to show (its notification tapped): at once if the web app
     * is there, else once it is. True when the intent was one.
     */
    private boolean voiceIntent(Intent intent) {
        int start = intent.getIntExtra(EXTRA_VOICE_START, -1);
        int show = intent.getIntExtra(EXTRA_VOICE_SHOW, -1);
        if (start < 0 && show < 0) return false;
        int session = start >= 0 ? start : show;
        String what = start >= 0 ? "start" : "show";
        backAfterCall = start >= 0 && intent.getBooleanExtra(EXTRA_VOICE_BACK, false);
        if (loaded) {
            web.evaluateJavascript(VoicePage.fromShell(session, what), null);
        } else {
            pendingVoice = session;
            pendingVoiceWhat = what;
        }
        return true;
    }

    /**
     * A notification tapped while the app runs: its session, at once if the web app is there. The assistant's sheet
     * opens a session (Open) or Menu › Assistant (to allow the microphone) the same way.
     */
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (voiceIntent(intent)) return;
        if (intent.getBooleanExtra(PiAssistantSession.EXTRA_ASSISTANT_SHEET, false)) {
            if (loaded) {
                web.evaluateJavascript("import(location.origin + '/store.js').then((store) => store.openSheet({ type: 'assistant' }))", null);
            } else {
                pendingAssistantSheet = true;
            }
            return;
        }
        int session = intent.getIntExtra(PiService.EXTRA_SESSION, -1);
        if (session < 0) return;
        if (loaded) {
            // An absolute address: a script run from here has no base URL (about:blank), so '/store.js' alone does not
            // resolve, and the app stayed where it was (PP-283: Open pi-phone from the floating board went home).
            web.evaluateJavascript("import(location.origin + '/store.js').then((store) => store.navigate(" + session + "))", null);
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
        if (requestCode == MIC_FOR_PAGE) {
            PermissionRequest request = pendingMic;
            pendingMic = null;
            if (request == null) return;
            if (results.length > 0 && results[0] == android.content.pm.PackageManager.PERMISSION_GRANTED) {
                request.grant(new String[] {PermissionRequest.RESOURCE_AUDIO_CAPTURE});
            } else {
                request.deny();
            }
            return;
        }
        super.onRequestPermissionsResult(requestCode, permissions, results);
    }

    @Override
    protected void onPause() {
        inFront = false;
        focused = false;
        super.onPause();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        focused = hasFocus;
    }

    private void waitForServer() {
        PiService.State last = null;
        while (!loaded) {
            PiService.State state = PiService.state();
            if (state == PiService.State.FAILED) {
                failure(getString(R.string.runtime_failed), PiService.failure(), true);
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
                    boolean assistant = pendingAssistantSheet;
                    pendingAssistantSheet = false;
                    int voice = pendingVoice;
                    pendingVoice = -1;
                    // A call to start or show: its session, and the web app does the rest (`voice` in `web/app.js`).
                    String next = voice >= 0 ? "/s/" + voice + "?voice=" + pendingVoiceWhat
                            : assistant ? "/?sheet=assistant" : session < 0 ? null : "/s/" + session;
                    String url = BASE + "/login?token=" + Uri.encode(PiService.ownerToken(this))
                            + (next == null ? "" : "&next=" + Uri.encode(next));
                    loaded = true;
                    statusShown = false;
                    runOnUiThread(() -> web.loadUrl(url));
                    if (!checked) {
                        checked = true;
                        runOnUiThread(() -> checkForUpdates(false));
                    }
                } catch (Exception e) {
                    failure(getString(R.string.cannot_sign_in), e.toString(), true);
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
    /** Whether pi-phone's server answers (not 503 while it starts): the assistant's sheet waits for it too. */
    static boolean answers() {
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

    /** How much of server.log's end the failure screen shows (its last error is found in it). */
    private static final int SHOWN_LOG_BYTES = 64 * 1024;
    /** How much of server.log's end Copy log puts on the clipboard (Android's clipboard goes through Binder). */
    private static final int COPIED_LOG_BYTES = 256 * 1024;
    /** How much of server.log's end Share log hands on, as a file. */
    private static final int SHARED_LOG_BYTES = 4 * 1024 * 1024;

    /** The last `max` bytes of server.log, from a whole line on. */
    private String logTail(int max) {
        File log = PiService.logFile(getFilesDir());
        try (RandomAccessFile file = new RandomAccessFile(log, "r")) {
            long start = Math.max(0, file.length() - max);
            byte[] bytes = new byte[(int) (file.length() - start)];
            file.seek(start);
            file.readFully(bytes);
            int from = 0;
            if (start > 0) {
                // Not half a line (nor half a character): from the next line on.
                while (from < bytes.length && bytes[from] != '\n') from++;
                from = Math.min(bytes.length, from + 1);
            }
            return new String(bytes, from, bytes.length - from, StandardCharsets.UTF_8);
        } catch (IOException e) {
            return "(no log: " + e + ")";
        }
    }

    /** Copy log: the end of server.log on the clipboard. */
    private void copyLog() {
        String text = logTail(COPIED_LOG_BYTES);
        runOnUiThread(() -> {
            ClipboardManager clipboard = getSystemService(ClipboardManager.class);
            clipboard.setPrimaryClip(ClipData.newPlainText("server.log", text));
            Toast.makeText(this, getString(R.string.log_copied), Toast.LENGTH_SHORT).show();
        });
    }

    /** Share log: the end of server.log (up to 4 MB) as a file, through Android's share sheet (`LogProvider`). */
    private void shareLog() {
        try {
            File shared = LogProvider.file(this);
            if (!shared.getParentFile().isDirectory() && !shared.getParentFile().mkdirs()) {
                throw new IOException("cannot create " + shared.getParentFile());
            }
            File log = PiService.logFile(getFilesDir());
            try (RandomAccessFile in = new RandomAccessFile(log, "r"); OutputStream out = new java.io.FileOutputStream(shared)) {
                long start = Math.max(0, in.length() - SHARED_LOG_BYTES);
                in.seek(start);
                byte[] buffer = new byte[64 * 1024];
                int read;
                while ((read = in.read(buffer)) >= 0) out.write(buffer, 0, read);
            }
            Uri uri = LogProvider.uri(this);
            Intent send = new Intent(Intent.ACTION_SEND)
                    .setType("text/plain")
                    .putExtra(Intent.EXTRA_STREAM, uri)
                    .putExtra(Intent.EXTRA_SUBJECT, getString(R.string.share_log_subject))
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            send.setClipData(ClipData.newRawUri("server.log", uri));
            runOnUiThread(() -> startActivity(Intent.createChooser(send, getString(R.string.share_log))));
        } catch (Exception e) {
            runOnUiThread(() -> alert(getString(R.string.could_not_share_log), e.toString()));
        }
    }

    /**
     * The app's own screen before the server answers (unpacking, updating, starting, downloading an update) and when
     * something failed: `assets/status.html`. It loads once; `show()` then changes it in place, so the spinner keeps
     * turning.
     */
    private String statusPage() {
        try (InputStream in = getAssets().open("status.html")) {
            return PiService.readAll(in);
        } catch (IOException e) {
            throw new IllegalStateException("The APK has no assets/status.html", e);
        }
    }

    /** Whether the status screen is what the WebView shows now (the app's page replaces it once the server answers). */
    private volatile boolean statusShown = false;

    /** Show the status screen as `state` says: loaded the first time, changed in place after. */
    private void show(JSONObject state) {
        runOnUiThread(() -> {
            if (statusShown) {
                web.evaluateJavascript("typeof show==='function'&&show(" + state + ")", null);
            } else {
                statusShown = true;
                web.loadDataWithBaseURL(null, statusPage() + "<script>show(" + state + ")</script></body></html>", "text/html", "utf-8", null);
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

    /**
     * A failure: what failed, why, and the end of server.log when `withLog` (the page puts its last error on top, with
     * Copy log and Share log).
     */
    private void failure(String title, String reason, boolean withLog) {
        try {
            JSONObject labels = new JSONObject()
                    .put("lastError", getString(R.string.last_error))
                    .put("log", getString(R.string.log_end))
                    .put("copy", getString(R.string.copy_log))
                    .put("share", getString(R.string.share_log));
            show(new JSONObject().put("title", title).put("note", reason).put("log", withLog ? logTail(SHOWN_LOG_BYTES) : "")
                    .put("labels", labels).put("failed", true));
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
                failure(getString(R.string.update_failed), getString(R.string.update_failed_note, e.toString()), false);
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
        // The window's call goes with its page: its notification and audio too (not a call the assistant's sheet holds).
        if (VoiceCallService.running() && VoiceCallService.page == callPage) {
            VoiceCallService.page = null;
            VoiceCallService.tell(this, VoiceCallService.ACTION_STOP, "", -1, false);
        }
        if (pendingMic != null) pendingMic.deny();
        dictation.release();
        speech.release();
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

    /** The volume keys turn a call's mic off and on while this window is in front, when Settings › Voice says so (PP-201). */
    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        if (VoiceCallService.volumeKey(event.getKeyCode(), event)) return true;
        return super.dispatchKeyEvent(event);
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else moveTaskToBack(true);
    }
}
