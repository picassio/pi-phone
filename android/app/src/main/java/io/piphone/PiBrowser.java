package io.piphone;

import android.app.Presentation;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.os.Message;
import android.os.Process;
import android.print.PiPdf;
import android.util.Base64;
import android.util.Log;
import android.view.ViewGroup;
import android.webkit.GeolocationPermissions;
import android.webkit.JsPromptResult;
import android.webkit.JsResult;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import androidx.webkit.ProfileStore;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;
import java.util.function.Supplier;

/**
 * Pi's browser on the phone (src/server/browser/pi-browser.ts): long-polls the server for what to do
 * (`GET /api/phone/browser`), makes or removes Pi's tabs (a WebView each, that only Pi uses), prints one to a PDF, and
 * answers (`POST /api/phone/browser/<id>`). The server drives the pages itself over the WebViews' DevTools socket (the APK
 * is debuggable, so Android opens one per process: `\0webview_devtools_remote_<pid>`), finding each by the
 * `about:blank#<marker>` it first loads.
 *
 * Each WebView lives in a Presentation on a private virtual display the size of the page, so its compositor draws every
 * frame (DevTools' screencast comes from there) with the app in the background or the screen off. The display's latest
 * frame is kept: Pi's pictures of the page are taken from it (`shot`), as DevTools' capture of the view hangs on every
 * other call (PP-114). Every
 * tab is in the WebView profile PROFILE: its cookies, storage, and sign-ins are its own, apart from the app's (whose
 * sign-in to this server a page must never ride on), and they stay across restarts. It never
 * loads this device or its local network: the app's own server is there, and a page could act as the owner.
 *
 * A window a page opens (window.open, a link to a new window: an MSAL sign-in, PP-249) becomes a tab of its own, in the
 * same profile, handed to the page through its WebViewTransport so window.opener and postMessage work. The server decides
 * first (`POST /api/phone/browser-window`; the setting browser.popups, perhaps the person's card) and answers with a
 * `window` request; a window that closes itself (window.close) closes its tab.
 */
final class PiBrowser {

    private static final String TAG = "pi-browser";
    private static final String BASE = "http://127.0.0.1:" + PiService.PORT;
    /** The WebView profile Pi's tabs use. */
    static final String PROFILE = "pi-browser";

    private final Context context;
    private final Supplier<String> token;
    private final BooleanSupplier serving;
    private final Handler main = new Handler(Looper.getMainLooper());
    /** The longest side of a picture of a page, in pixels: models take none larger once a conversation holds many. */
    private static final int PICTURE_MAX = 2000;

    /** A tab: its WebView, the display and window it draws on, and the display's latest frame (main thread). */
    private static final class Tab {
        WebView page;
        VirtualDisplay display;
        ImageReader frames;
        Image latest;
        Presentation window;
    }

    /** Pi's tabs by marker, oldest first (main thread). */
    private final Map<String, Tab> tabs = new LinkedHashMap<>();

    /** What a page's window.open may do, as the server last said (its setting browser.popups: allow, ask, off; main thread). */
    private String popups = "allow";

    /** A window a page asked to open, waiting for the server's answer: the message that gives the page its window, and its tab. */
    private static final class Window {
        final Message message;
        final String opener;

        Window(Message message, String opener) {
            this.message = message;
            this.opener = opener;
        }
    }

    /** Windows waiting for the server, by the marker their tab will have (main thread). */
    private final Map<String, Window> windows = new HashMap<>();

    /**
     * Every tab's windows and dialogs (main thread). Dialogs are cancelled, as with no WebChromeClient: the page's own
     * alert, confirm and prompt are answered in the page (page.ts), and a display of Pi's has no one to answer one.
     */
    private final WebChromeClient chrome = new WebChromeClient() {
        @Override
        public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, Message resultMsg) {
            String opener = markerOf(view);

            // Off: the page gets no window (without a click, window.open has returned null already).
            if (opener == null || "off".equals(popups)) return false;
            String marker = "pi-browser-" + UUID.randomUUID();
            JSONObject asked = new JSONObject();
            try {
                asked.put("opener", opener).put("tab", marker).put("gesture", isUserGesture);
            } catch (JSONException e) {
                return false;
            }
            windows.put(marker, new Window(resultMsg, opener));
            // The server answers with a "window" request: open it as a tab, or not.
            new Thread(() -> {
                try {
                    int code = send("/api/phone/browser-window", asked);
                    if (code != 200) throw new IOException("HTTP " + code);
                } catch (Exception e) {
                    Log.w(TAG, "browser window: " + e);
                    main.post(() -> refuse(marker));
                }
            }, "pi-browser-window").start();
            return true;
        }

        @Override
        public void onCloseWindow(WebView window) {
            String marker = markerOf(window);

            // After this call returns: a view is not destroyed inside its own callback.
            if (marker != null) main.post(() -> close(marker));
        }

        @Override
        public boolean onJsAlert(WebView view, String url, String message, JsResult result) {
            result.cancel();
            return true;
        }

        @Override
        public boolean onJsConfirm(WebView view, String url, String message, JsResult result) {
            result.cancel();
            return true;
        }

        @Override
        public boolean onJsPrompt(WebView view, String url, String message, String defaultValue, JsPromptResult result) {
            result.cancel();
            return true;
        }

        @Override
        public boolean onJsBeforeUnload(WebView view, String url, String message, JsResult result) {
            // Leave the page, as without a WebChromeClient: cancelling would keep Pi on a page that asks before leaving.
            result.confirm();
            return true;
        }

        @Override
        public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
            callback.invoke(origin, false, false);
        }
    };

    PiBrowser(Context context, Supplier<String> token, BooleanSupplier serving) {
        this.context = context;
        this.token = token;
        this.serving = serving;
    }

    /** The poll: runs until interrupted. */
    void loop() {
        long after = -1;
        while (!Thread.currentThread().isInterrupted()) {
            try {
                if (!serving.getAsBoolean()) {
                    after = -1;
                    Thread.sleep(2000);
                    continue;
                }
                HttpURLConnection connection = (HttpURLConnection) new URL(BASE + "/api/phone/browser?after=" + after).openConnection();
                connection.setConnectTimeout(3000);
                connection.setReadTimeout(70_000);
                connection.setRequestProperty("Authorization", "Bearer " + token.get());
                if (connection.getResponseCode() != 200) throw new IOException("HTTP " + connection.getResponseCode());
                JSONObject answer;
                try (InputStream in = connection.getInputStream()) {
                    answer = new JSONObject(readAll(in));
                }
                long seq = answer.getLong("seq");
                if (seq < after) {
                    after = -1;
                    continue;
                }
                JSONArray requests = answer.getJSONArray("requests");
                for (int index = 0; index < requests.length(); index++) {
                    handle(requests.getJSONObject(index));
                }
                after = seq;
            } catch (InterruptedException e) {
                return;
            } catch (Exception e) {
                Log.w(TAG, "browser: " + e);
                try {
                    Thread.sleep(3000);
                } catch (InterruptedException stopped) {
                    return;
                }
            }
        }
    }

    private void handle(JSONObject request) throws Exception {
        String id = request.getString("id");
        JSONObject reply = new JSONObject();
        try {
            String op = request.getString("op");
            CountDownLatch done = new CountDownLatch(1);
            Exception[] failed = new Exception[1];
            main.post(() -> {
                try {
                    reply.put("pid", Process.myPid());
                    if (op.equals("tabs")) {
                        // Tabs kept from before (the server restarted, the app did not) have moved on from their markers:
                        // their addresses find them too.
                        JSONArray list = new JSONArray();
                        for (Map.Entry<String, Tab> tab : tabs.entrySet()) {
                            String url = tab.getValue().page.getUrl();
                            list.put(new JSONObject().put("marker", tab.getKey()).put("url", url == null ? "" : url));
                        }
                        reply.put("tabs", list);
                        popups(request.getString("popups"));
                    } else if (op.equals("open")) {
                        popups(request.getString("popups"));
                        open(request.getString("marker"), request.getInt("width"), request.getInt("height"));
                    } else if (op.equals("popups")) {
                        popups(request.getString("popups"));
                    } else if (op.equals("window")) {
                        boolean open = request.getBoolean("open");
                        window(request.getString("marker"), open, open ? request.getInt("width") : 0, open ? request.getInt("height") : 0);
                    } else if (op.equals("close")) {
                        if (request.has("marker")) close(request.getString("marker"));
                        else for (String marker : tabs.keySet().toArray(new String[0])) close(marker);
                    } else if (op.equals("shot")) {
                        Tab tab = tabs.get(request.getString("marker"));
                        if (tab == null) throw new IllegalArgumentException("there is no such tab");
                        int quality = request.optInt("quality", 70);
                        boolean png = request.optBoolean("png", false);
                        // A part of the view, in CSS pixels (PP-118); none: all of it.
                        JSONObject clip = request.optJSONObject("clip");
                        // A draw the page still owes comes in first; a still page draws nothing new, and its last frame is it.
                        tab.page.invalidate();
                        main.postDelayed(() -> {
                            try {
                                reply.put("jpeg", picture(tab, quality, png, clip));
                            } catch (Exception e) {
                                failed[0] = e;
                            }
                            done.countDown();
                        }, 250);
                        return;
                    } else if (op.equals("pdf")) {
                        Tab tab = tabs.get(request.getString("marker"));
                        if (tab == null) throw new IllegalArgumentException("there is no such tab");
                        // Printing finishes later, on this thread: the answer waits for it.
                        PiPdf.write(tab.page.createPrintDocumentAdapter("page"), new File(request.getString("path")), (error) -> {
                            if (error != null) failed[0] = new IOException("printing failed: " + error);
                            done.countDown();
                        });
                        return;
                    } else {
                        throw new IllegalArgumentException("unknown request " + op);
                    }
                } catch (Exception e) {
                    failed[0] = e;
                }
                done.countDown();
            });
            if (!done.await(80, TimeUnit.SECONDS)) throw new IOException("the browser did not answer in time");
            if (failed[0] != null) throw failed[0];
        } catch (Exception e) {
            reply.put("error", e.getMessage() == null ? e.toString() : e.getMessage());
        }
        post(id, reply);
    }

    /** Make a tab, and load its marker: the server finds its page by it (main thread). */
    private void open(String marker, int width, int height) {
        if (tabs.containsKey(marker)) return;
        make(marker, width, height).page.loadUrl("about:blank#" + marker);
    }

    /** What pages may do with window.open (browser.popups): allow, ask or off (main thread). */
    private void popups(String mode) {
        if (!("allow".equals(mode) || "ask".equals(mode) || "off".equals(mode))) {
            throw new IllegalArgumentException("popups is allow, ask or off, not " + mode);
        }
        popups = mode;
        for (Tab tab : tabs.values()) tab.page.getSettings().setJavaScriptCanOpenWindowsAutomatically(!"off".equals(mode));
    }

    /** The marker of a tab's view, or null for none of Pi's (main thread). */
    private String markerOf(WebView view) {
        for (Map.Entry<String, Tab> tab : tabs.entrySet()) {
            if (tab.getValue().page == view) return tab.getKey();
        }
        return null;
    }

    /**
     * The server's answer to a window a page asked to open: a tab of its own, at `width` × `height`, given to the page
     * (window.opener stays), or none, and the page's window closes (main thread).
     */
    private void window(String marker, boolean open, int width, int height) {
        Window asked = windows.remove(marker);
        if (asked == null) throw new IllegalArgumentException("no window waits as " + marker);
        WebView.WebViewTransport transport = (WebView.WebViewTransport) asked.message.obj;
        if (!open) {
            transport.setWebView(null);
            asked.message.sendToTarget();
            return;
        }
        if (!tabs.containsKey(asked.opener)) throw new IllegalStateException("the tab that asked for the window is closed");
        Tab tab;
        try {
            // Not loaded: the page that opened it loads it.
            tab = make(marker, width, height);
        } catch (RuntimeException failed) {
            transport.setWebView(null);
            asked.message.sendToTarget();
            throw failed;
        }
        transport.setWebView(tab.page);
        asked.message.sendToTarget();
    }

    /** A window the server could not be asked about: the page's window closes (main thread). */
    private void refuse(String marker) {
        Window asked = windows.remove(marker);
        if (asked == null || !tabs.containsKey(asked.opener)) return;
        ((WebView.WebViewTransport) asked.message.obj).setWebView(null);
        asked.message.sendToTarget();
    }

    /**
     * Make a tab: a WebView of its own, on a display of its own, not loaded yet (a window's WebView must be fresh for the
     * page that opens it). Main thread.
     */
    private Tab make(String marker, int width, int height) {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) {
            throw new IllegalStateException("Pi's browser needs a newer Android System WebView (110 or later): update it in the Play Store");
        }
        Tab tab = new Tab();
        float density = context.getResources().getDisplayMetrics().density;
        int dpi = context.getResources().getDisplayMetrics().densityDpi;
        int widthPx = Math.round(width * density);
        int heightPx = Math.round(height * density);
        // Two images: the one kept, and the next one coming in.
        ImageReader frames = ImageReader.newInstance(widthPx, heightPx, PixelFormat.RGBA_8888, 2);
        frames.setOnImageAvailableListener((reader) -> {
            Image frame = reader.acquireLatestImage();
            if (frame == null) return;
            if (tab.latest != null) tab.latest.close();
            tab.latest = frame;
        }, main);
        VirtualDisplay display = context.getSystemService(DisplayManager.class)
                .createVirtualDisplay("pi-phone-browser", widthPx, heightPx, dpi, frames.getSurface(), 0);
        if (display == null) {
            frames.close();
            throw new IllegalStateException("Android gave no display for Pi's browser");
        }
        Presentation window = new Presentation(context, display.getDisplay());
        FrameLayout box = new FrameLayout(window.getContext());
        window.setContentView(box);
        window.show();

        WebView view = new WebView(window.getContext());
        // Before anything else on the view: the profile is set once, for its life.
        ProfileStore.getInstance().getOrCreateProfile(PROFILE);
        WebViewCompat.setProfile(view, PROFILE);
        view.setBackgroundColor(Color.WHITE);
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        // Windows pages open become tabs (onCreateWindow); without a click only while browser.popups is not off.
        settings.setSupportMultipleWindows(true);
        settings.setJavaScriptCanOpenWindowsAutomatically(!"off".equals(popups));
        settings.setMediaPlaybackRequiresUserGesture(true);
        view.setWebChromeClient(chrome);
        view.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                // Web pages only: no app links, intents, or files.
                String scheme = request.getUrl().getScheme();
                return !("http".equals(scheme) || "https".equals(scheme) || "about".equals(scheme));
            }

            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return local(request.getUrl())
                        ? new WebResourceResponse("text/plain", "utf-8", 403, "Forbidden", null, new ByteArrayInputStream(new byte[0]))
                        : null;
            }
        });
        box.addView(view, new ViewGroup.LayoutParams(widthPx, heightPx));
        tab.page = view;
        tab.display = display;
        tab.frames = frames;
        tab.window = window;
        tabs.put(marker, tab);
        return tab;
    }

    /** This device or its local network, by the address written: the app's server, the owner's machines. */
    private static boolean local(Uri url) {
        String host = url.getHost();
        if (host == null) return false;
        host = host.toLowerCase();
        if (host.equals("localhost") || host.endsWith(".localhost") || host.equals("[::1]") || host.equals("::1") || host.equals("0.0.0.0")) return true;
        String[] parts = host.split("\\.");
        if (parts.length != 4) return false;
        int[] octets = new int[4];
        try {
            for (int index = 0; index < 4; index++) octets[index] = Integer.parseInt(parts[index]);
        } catch (NumberFormatException notAnAddress) {
            return false;
        }
        return octets[0] == 127 || octets[0] == 10 || (octets[0] == 192 && octets[1] == 168) || (octets[0] == 169 && octets[1] == 254)
                || (octets[0] == 172 && octets[1] >= 16 && octets[1] <= 31) || (octets[0] == 100 && octets[1] >= 64 && octets[1] <= 127);
    }

    /** Remove a tab: its WebView, window and display (main thread). */
    private void close(String marker) {
        Tab tab = tabs.remove(marker);
        if (tab == null) return;
        // Windows its page asked for go with it, unanswered: their opener is gone.
        for (Iterator<Window> each = windows.values().iterator(); each.hasNext(); ) {
            if (each.next().opener.equals(marker)) each.remove();
        }
        tab.page.destroy();
        tab.window.dismiss();
        tab.display.release();
        if (tab.latest != null) tab.latest.close();
        tab.latest = null;
        tab.frames.close();
    }

    /**
     * The tab's latest frame, or the part `clip` names (CSS pixels), as a JPEG or PNG (base64), at most twice its CSS
     * pixels and PICTURE_MAX on its longest side (main thread).
     */
    private String picture(Tab tab, int quality, boolean png, JSONObject clip) throws Exception {
        Image frame = tab.latest;
        if (frame == null) throw new IOException("the page has not been drawn yet");
        int frameWidth = frame.getWidth();
        int frameHeight = frame.getHeight();
        float density = context.getResources().getDisplayMetrics().density;
        Rect part = new Rect(0, 0, frameWidth, frameHeight);
        if (clip != null) {
            int left = Math.max(0, Math.round((float) clip.getDouble("x") * density));
            int top = Math.max(0, Math.round((float) clip.getDouble("y") * density));
            part = new Rect(left, top,
                    Math.min(frameWidth, left + Math.round((float) clip.getDouble("width") * density)),
                    Math.min(frameHeight, top + Math.round((float) clip.getDouble("height") * density)));
            if (part.width() < 1 || part.height() < 1) throw new IOException("that part of the page is not in view");
        }
        int width = part.width();
        int height = part.height();
        Image.Plane plane = frame.getPlanes()[0];
        int stride = plane.getRowStride() / plane.getPixelStride();
        float scale = Math.min(1f, Math.min(2f / density, PICTURE_MAX / (float) Math.max(width, height)));
        int outWidth = Math.max(1, Math.round(width * scale));
        int outHeight = Math.max(1, Math.round(height * scale));
        Bitmap whole = Bitmap.createBitmap(stride, frameHeight, Bitmap.Config.ARGB_8888);
        Bitmap out = null;
        try {
            whole.copyPixelsFromBuffer(plane.getBuffer().rewind());
            out = Bitmap.createBitmap(outWidth, outHeight, Bitmap.Config.ARGB_8888);
            Canvas canvas = new Canvas(out);
            canvas.drawColor(Color.WHITE);
            canvas.drawBitmap(whole, part, new Rect(0, 0, outWidth, outHeight), new Paint(Paint.FILTER_BITMAP_FLAG));
            ByteArrayOutputStream encoded = new ByteArrayOutputStream();
            out.compress(png ? Bitmap.CompressFormat.PNG : Bitmap.CompressFormat.JPEG, quality, encoded);
            return Base64.encodeToString(encoded.toByteArray(), Base64.NO_WRAP);
        } finally {
            whole.recycle();
            if (out != null) out.recycle();
        }
    }

    private void post(String id, JSONObject reply) throws IOException {
        int code = send("/api/phone/browser/" + id, reply);
        if (code != 200) Log.w(TAG, "browser answer: HTTP " + code);
    }

    /** POST `body` to the server at `path`: its HTTP status. */
    private int send(String path, JSONObject body) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(BASE + path).openConnection();
        connection.setConnectTimeout(3000);
        connection.setReadTimeout(30_000);
        connection.setDoOutput(true);
        connection.setRequestMethod("POST");
        connection.setRequestProperty("Authorization", "Bearer " + token.get());
        connection.setRequestProperty("X-Pocket", "1");
        connection.setRequestProperty("Content-Type", "application/json");
        byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
        try (OutputStream out = connection.getOutputStream()) {
            out.write(bytes);
        }
        int code = connection.getResponseCode();
        connection.disconnect();
        return code;
    }

    private static String readAll(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int read;
        while ((read = in.read(buffer)) != -1) out.write(buffer, 0, read);
        return out.toString("UTF-8");
    }
}
