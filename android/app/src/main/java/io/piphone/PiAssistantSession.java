package io.piphone;

import android.app.KeyguardManager;
import android.app.assist.AssistContent;
import android.app.assist.AssistStructure;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.service.voice.VoiceInteractionSession;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * The assistant's sheet over the app in front (PP-146). Its window is the whole screen, see-through: a WebView on the
 * web app's assistant view (`/?assist=1`, `web/assist.js`) draws the dimmed backdrop and the sheet, so the sheet is the
 * app's own look and code. Until the server answers (a phone just started), a small page says pi is starting, and the
 * sheet loads once it does: nothing is heard before the sheet can send it.
 *
 * What the web view may ask (`PiPhoneApp`, as in the app, for what it needs here): dictation on Android's recognizer
 * (`Dictation`, which cannot ask for the microphone here: no activity), the app that was in front (from the assist
 * data, its name only), close, open a session in the app, and open Menu › Assistant to allow the microphone.
 */
final class PiAssistantSession extends VoiceInteractionSession {
    /** For `MainActivity`: open Menu › Assistant (to allow the microphone there). */
    static final String EXTRA_ASSISTANT_SHEET = "io.piphone.ASSISTANT_SHEET";
    private static final String BASE = "http://127.0.0.1:" + PiService.PORT;
    /** How long the sheet waits for a server that is starting, at most. */
    private static final long WAIT_MS = 90_000;

    /** The sheet showing now, if one is: phone control puts it away before it reads or acts (`hideShown`). */
    private static volatile PiAssistantSession shown;
    /** The session of the voice call the sheet holds (PP-192), or -1. */
    private static volatile int callSession = -1;
    /** The sheet goes because Open took the person to the app: a call handed over stays in front there. */
    private volatile boolean opening;

    private final Handler main = new Handler(Looper.getMainLooper());
    private WebView web;
    private Dictation dictation;
    /** The app in front when the side key was held, as JSON `{label, package}`, or "" when not known (or not useful). */
    private volatile String from = "";
    /** The sheet's page is there, or on its way. */
    private boolean started;
    private volatile boolean gone;

    PiAssistantSession(Context context) {
        super(context);
    }

    @Override
    public void onCreate() {
        super.onCreate();
        // See-through: the web view draws the backdrop over the app in front.
        if (getWindow() != null && getWindow().getWindow() != null) {
            getWindow().getWindow().setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
        }
    }

    @Override
    public View onCreateContentView() {
        web = new WebView(getContext());
        web.setBackgroundColor(Color.TRANSPARENT);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMediaPlaybackRequiresUserGesture(false);
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                if (BASE.equals(url.getScheme() + "://" + url.getAuthority())) return false;
                // A link out of the sheet opens in the phone's browser, and the sheet goes.
                startAssistantActivity(new Intent(Intent.ACTION_VIEW, url).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                hide();
                return true;
            }
        });
        // The microphone for a voice call in the sheet (PP-192): the app's own page, audio only, once pi has it. The sheet
        // cannot ask Android (no activity): the page says so, and Allow in pi-phone does it.
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                if (VoicePage.ownAudio(request) && dictation.micAllowed()) {
                    request.grant(new String[] {PermissionRequest.RESOURCE_AUDIO_CAPTURE});
                } else {
                    request.deny();
                }
            }
        });
        dictation = new Dictation(getContext(), null, web);
        web.addJavascriptInterface(new Bridge(), "PiPhoneApp");
        return web;
    }

    /**
     * Put the sheet away when it shows, for phone control: true when it did (the caller waits for it to go). The session
     * keeps working; the owner sees its reply in the app, or in the sheet the next time.
     */
    static boolean hideShown() {
        PiAssistantSession sheet = shown;
        if (sheet == null) return false;
        shown = null;
        sheet.main.post(sheet::hide);
        return true;
    }

    @Override
    public void onShow(Bundle args, int showFlags) {
        super.onShow(args, showFlags);
        shown = this;
        KeyguardManager keyguard = getContext().getSystemService(KeyguardManager.class);
        if (keyguard != null && keyguard.isKeyguardLocked()) {
            // Pi is not reachable from the lock screen.
            started = false;
            page(getContext().getString(R.string.assistant_locked), false);
            return;
        }
        if (started) {
            // Shown again: the sheet starts over (listening, the setting's session).
            web.evaluateJavascript("globalThis.__piAssistShown && globalThis.__piAssistShown()", null);
            return;
        }
        started = true;
        page(getContext().getString(R.string.assistant_starting), true);
        getContext().startForegroundService(new Intent(getContext(), PiService.class));
        new Thread(this::waitForServer, "pi-assist-wait").start();
    }

    /**
     * The assist data of the app in front: its package (its activity's, else the one Android names), and its name. Not
     * pi-phone itself, nor the home screen: "From pi" or "From One UI Home" tells Pi nothing.
     */
    @Override
    @SuppressWarnings("deprecation")
    public void onHandleAssist(Bundle data, AssistStructure structure, AssistContent content) {
        ComponentName activity = structure == null ? null : structure.getActivityComponent();
        String pkg = activity != null ? activity.getPackageName() : data == null ? null : data.getString(Intent.EXTRA_ASSIST_PACKAGE);
        if (pkg == null || pkg.equals(getContext().getPackageName()) || pkg.equals(home())) return;
        try {
            PackageManager packages = getContext().getPackageManager();
            String label = String.valueOf(packages.getApplicationLabel(packages.getApplicationInfo(pkg, 0)));
            from = new JSONObject().put("label", label).put("package", pkg).toString();
        } catch (PackageManager.NameNotFoundException | JSONException e) {
            return;
        }
        String told = from;
        main.post(() -> {
            if (web != null) web.evaluateJavascript("globalThis.__piAssistFrom && globalThis.__piAssistFrom(" + told + ")", null);
        });
    }

    @Override
    public void onHide() {
        if (shown == this) shown = null;
        // A call in the sheet moves to the app's window (PP-192): the sheet's page ends its own, and the window starts
        // one in the same session, then goes back behind the app that was in front (unless Open took the person there).
        int call = callSession;
        if (call >= 0 && web != null) {
            callSession = -1;
            web.evaluateJavascript("globalThis.__piVoiceHandOver && globalThis.__piVoiceHandOver()", null);
            startAssistantActivity(new Intent(getContext(), MainActivity.class)
                    .putExtra(MainActivity.EXTRA_VOICE_START, call)
                    .putExtra(MainActivity.EXTRA_VOICE_BACK, !opening)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        }
        opening = false;
        // The next time, the app in front is told again (its assist data may come before or after onShow).
        from = "";
        if (dictation != null) dictation.abort();
        if (web != null) web.evaluateJavascript("globalThis.__piAssistHidden && globalThis.__piAssistHidden()", null);
        super.onHide();
    }

    @Override
    public void onDestroy() {
        gone = true;
        if (dictation != null) dictation.release();
        if (web != null) web.destroy();
        super.onDestroy();
    }

    /** The phone's home screen app, which Android names as the app in front on the home screen. */
    private String home() {
        ResolveInfo found = getContext().getPackageManager().resolveActivity(
                new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME), PackageManager.MATCH_DEFAULT_ONLY);
        return found == null || found.activityInfo == null ? null : found.activityInfo.packageName;
    }

    /** Wait for the server, then the sheet's own page, signed in as the owner, as the app's window signs in. */
    private void waitForServer() {
        long until = System.currentTimeMillis() + WAIT_MS;
        while (!gone) {
            PiService.State state = PiService.state();
            if (state == PiService.State.FAILED) {
                main.post(this::failed);
                return;
            }
            if ((state == PiService.State.STARTING || state == PiService.State.RUNNING) && MainActivity.answers()) {
                PiService.markRunning();
                try {
                    String url = BASE + "/login?token=" + Uri.encode(PiService.ownerToken(getContext())) + "&next=" + Uri.encode("/?assist=1");
                    main.post(() -> web.loadUrl(url));
                } catch (Exception e) {
                    main.post(this::failed);
                }
                return;
            }
            if (System.currentTimeMillis() > until) {
                main.post(this::failed);
                return;
            }
            try {
                Thread.sleep(300);
            } catch (InterruptedException e) {
                return;
            }
        }
    }

    /** pi did not start: said so; the next time the sheet is shown, it tries again. */
    private void failed() {
        started = false;
        page(getContext().getString(R.string.assistant_failed), false);
    }

    /** A plain sheet with one line (starting, locked, failed): the app's colors; a tap above it closes it. */
    private void page(String text, boolean busy) {
        String html = "<!doctype html><html><head><meta name=viewport content='width=device-width,initial-scale=1'><style>"
                + "html,body{margin:0;height:100%;background:rgba(8,9,14,.42);font:15px system-ui,sans-serif}"
                + ".s{position:fixed;left:0;right:0;bottom:0;background:#1a1b26;color:#c0caf5;border-radius:18px 18px 0 0;padding:22px 20px 34px;display:flex;gap:12px;align-items:center}"
                + ".r{width:18px;height:18px;border-radius:50%;border:2px solid #2f3247;border-top-color:#7aa2f7;animation:r .8s linear infinite;flex:none}"
                + "@keyframes r{to{transform:rotate(360deg)}}</style></head><body onclick=\"if(event.target===document.body)PiPhoneApp.close()\">"
                + "<div class=s>" + (busy ? "<span class=r></span>" : "") + "<span>" + android.text.Html.escapeHtml(text) + "</span></div></body></html>";
        web.loadDataWithBaseURL(null, html, "text/html", "utf-8", null);
    }

    /** What the sheet's page may ask. */
    private final class Bridge {
        @JavascriptInterface
        public boolean dictationAvailable() {
            return dictation.available();
        }

        @JavascriptInterface
        public boolean micAllowed() {
            return dictation.micAllowed();
        }

        @JavascriptInterface
        public void startDictation(String language) {
            main.post(() -> dictation.start(language));
        }

        @JavascriptInterface
        public void stopDictation() {
            main.post(() -> dictation.stop());
        }

        @JavascriptInterface
        public void abortDictation() {
            main.post(() -> dictation.abort());
        }

        /** The app that was in front, as `{label, package}` JSON, or "". */
        @JavascriptInterface
        public String from() {
            return from;
        }

        @JavascriptInterface
        public void close() {
            main.post(PiAssistantSession.this::hide);
        }

        /** The sheet's voice call started, changed, or ended (`web/voice-call.js`): its notification and audio follow. */
        @JavascriptInterface
        public void voiceCall(String json) {
            main.post(() -> {
                try {
                    String state = VoicePage.tell(getContext(), json);
                    if ("start".equals(state)) {
                        callSession = new JSONObject(json).optInt("session", -1);
                        VoiceCallService.page = (action) -> main.post(() -> {
                            if (web != null) web.evaluateJavascript(VoicePage.action(action), null);
                        });
                    } else if ("end".equals(state)) {
                        callSession = -1;
                    }
                } catch (JSONException e) {
                    android.util.Log.w("pi-phone", "voice call: " + e);
                }
            });
        }

        /** Open this session in the app, and close the sheet. */
        @JavascriptInterface
        public void open(int session) {
            opening = true;
            main.post(() -> {
                startAssistantActivity(new Intent(getContext(), MainActivity.class)
                        .putExtra(PiService.EXTRA_SESSION, session)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                hide();
            });
        }

        /** Menu › Assistant in the app, where Android can ask for the microphone; the sheet closes. */
        @JavascriptInterface
        public void allowMic() {
            main.post(() -> {
                startAssistantActivity(new Intent(getContext(), MainActivity.class)
                        .putExtra(EXTRA_ASSISTANT_SHEET, true)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                hide();
            });
        }

        /** Sign in again (`web/signin.js`), as the app's window does. */
        @JavascriptInterface
        public void signIn() {
            try {
                String url = BASE + "/login?token=" + Uri.encode(PiService.ownerToken(getContext())) + "&next=" + Uri.encode("/?assist=1");
                main.post(() -> web.loadUrl(url));
            } catch (Exception e) {
                main.post(PiAssistantSession.this::failed);
            }
        }
    }
}
