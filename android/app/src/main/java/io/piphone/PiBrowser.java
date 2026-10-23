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
import android.os.Process;
import android.print.PiPdf;
import android.util.Base64;
import android.util.Log;
import android.view.ViewGroup;
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
import java.util.LinkedHashMap;
import java.util.Map;
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
                    } else if (op.equals("open")) {
                        open(request.getString("marker"), request.getInt("width"), request.getInt("height"));
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

    /** Make a tab: a WebView of its own, on a display of its own (main thread). */
    private void open(String marker, int width, int height) {
        if (tabs.containsKey(marker)) return;
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
        settings.setSupportMultipleWindows(false);
        settings.setMediaPlaybackRequiresUserGesture(true);
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
        view.loadUrl("about:blank#" + marker);
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
        HttpURLConnection connection = (HttpURLConnection) new URL(BASE + "/api/phone/browser/" + id).openConnection();
        connection.setConnectTimeout(3000);
        connection.setReadTimeout(30_000);
        connection.setDoOutput(true);
        connection.setRequestMethod("POST");
        connection.setRequestProperty("Authorization", "Bearer " + token.get());
        connection.setRequestProperty("X-Pocket", "1");
        connection.setRequestProperty("Content-Type", "application/json");
        byte[] body = reply.toString().getBytes(StandardCharsets.UTF_8);
        try (OutputStream out = connection.getOutputStream()) {
            out.write(body);
        }
        int code = connection.getResponseCode();
        if (code != 200) Log.w(TAG, "browser answer: HTTP " + code);
        connection.disconnect();
    }

    private static String readAll(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int read;
        while ((read = in.read(buffer)) != -1) out.write(buffer, 0, read);
        return out.toString("UTF-8");
    }
}
