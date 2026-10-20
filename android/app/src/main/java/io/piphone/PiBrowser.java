package io.piphone;

import android.app.Presentation;
import android.content.Context;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.os.Process;
import android.util.Log;
import android.view.ViewGroup;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;
import java.util.function.Supplier;

/**
 * Pi's browser on the phone (src/server/browser/pi-browser.ts): long-polls the server for what to do
 * (`GET /api/phone/browser`), makes or removes a WebView that only Pi uses, and answers (`POST /api/phone/browser/<id>`).
 * The server drives the page itself over the WebView's DevTools socket (the APK is debuggable, so Android opens one per
 * process: `\0webview_devtools_remote_<pid>`), finding it by the `about:blank#<marker>` it first loads.
 *
 * The WebView lives in a Presentation on a private virtual display the size of the page, so its compositor draws every
 * frame (DevTools' screencast and screenshots come from there) with the app in the background or the screen off. It never
 * loads this device or its local network: the app's own server is there, and a page could act as the owner.
 */
final class PiBrowser {

    private static final String TAG = "pi-browser";
    private static final String BASE = "http://127.0.0.1:" + PiService.PORT;

    private final Context context;
    private final Supplier<String> token;
    private final BooleanSupplier serving;
    private final Handler main = new Handler(Looper.getMainLooper());
    private WebView page;
    private String marker;
    private VirtualDisplay display;
    private ImageReader frames;
    private Presentation window;

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
                    if (op.equals("open")) {
                        open(request.getString("marker"), request.getInt("width"), request.getInt("height"));
                        reply.put("pid", Process.myPid()).put("marker", marker);
                    } else if (op.equals("close")) {
                        close();
                    } else {
                        throw new IllegalArgumentException("unknown request " + op);
                    }
                } catch (Exception e) {
                    failed[0] = e;
                }
                done.countDown();
            });
            if (!done.await(20, TimeUnit.SECONDS)) throw new IOException("the browser did not answer in time");
            if (failed[0] != null) throw failed[0];
        } catch (Exception e) {
            reply.put("error", e.getMessage() == null ? e.toString() : e.getMessage());
        }
        post(id, reply);
    }

    /** Make Pi's WebView, if there is none (main thread). A page already open stays, with the marker it was made with. */
    private void open(String wanted, int width, int height) {
        if (page != null) return;
        float density = context.getResources().getDisplayMetrics().density;
        int dpi = context.getResources().getDisplayMetrics().densityDpi;
        int widthPx = Math.round(width * density);
        int heightPx = Math.round(height * density);
        frames = ImageReader.newInstance(widthPx, heightPx, PixelFormat.RGBA_8888, 2);
        frames.setOnImageAvailableListener((reader) -> {
            Image frame = reader.acquireLatestImage();
            if (frame != null) frame.close();
        }, main);
        display = context.getSystemService(DisplayManager.class)
                .createVirtualDisplay("pi-phone-browser", widthPx, heightPx, dpi, frames.getSurface(), 0);
        if (display == null) throw new IllegalStateException("Android gave no display for Pi's browser");
        window = new Presentation(context, display.getDisplay());
        FrameLayout box = new FrameLayout(window.getContext());
        window.setContentView(box);
        window.show();

        WebView view = new WebView(window.getContext());
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
        page = view;
        marker = wanted;
        view.loadUrl("about:blank#" + wanted);
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

    /** Remove Pi's WebView and its window (main thread). */
    private void close() {
        if (page != null) {
            page.destroy();
            page = null;
        }
        marker = null;
        if (window != null) {
            window.dismiss();
            window = null;
        }
        if (display != null) {
            display.release();
            display = null;
        }
        if (frames != null) {
            frames.close();
            frames = null;
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
