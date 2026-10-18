package io.piphone;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.util.Log;
import android.view.View;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;
import java.util.function.Supplier;

/**
 * Screenshots for Pi (src/server/screenshots.ts, DESIGN.md section 4): long-polls the server for pages to render
 * (`GET /api/phone/renders`), draws each in an off-screen WebView of the app at the widths asked, signed in as the app's
 * own WebView is (the same cookies, and the owner token on the app's own pages), and posts JPEGs back
 * (`POST /api/phone/renders/<id>`). The WebView is never shown: it is measured and laid out at the width, and drawn
 * whole (`enableSlowWholeDocumentDraw`, set before the app's first WebView) into a bitmap at CSS-pixel scale.
 */
final class Renderer {

    private static final String TAG = "pi-render";
    private static final String BASE = "http://127.0.0.1:" + PiService.PORT;
    /** How long one width may take, loading included. */
    private static final long SHOT_MS = 45_000;

    private final Context context;
    private final Supplier<String> token;
    private final BooleanSupplier serving;
    private final Handler main = new Handler(Looper.getMainLooper());

    /** Before any WebView of the process: drawing then covers the whole page, not only what would be on screen. */
    static void prepare() {
        WebView.enableSlowWholeDocumentDraw();
    }

    Renderer(Context context, Supplier<String> token, BooleanSupplier serving) {
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
                HttpURLConnection connection = (HttpURLConnection) new URL(BASE + "/api/phone/renders?after=" + after).openConnection();
                connection.setConnectTimeout(3000);
                connection.setReadTimeout(70_000);
                connection.setRequestProperty("Authorization", "Bearer " + token.get());
                if (connection.getResponseCode() != 200) throw new IOException("HTTP " + connection.getResponseCode());
                JSONObject answer;
                try (InputStream in = connection.getInputStream()) {
                    answer = new JSONObject(readAll(in));
                }
                long seq = answer.getLong("seq");
                // A server that started again counts from 0: take what waits there.
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
                Log.w(TAG, "renders: " + e);
                try {
                    Thread.sleep(3000);
                } catch (InterruptedException stopped) {
                    return;
                }
            }
        }
    }

    /** One request: every width, then the answer; a failure is the answer too. */
    private void handle(JSONObject request) throws Exception {
        String id = request.getString("id");
        JSONObject reply = new JSONObject();
        try {
            JSONArray widths = request.getJSONArray("widths");
            JSONArray shots = new JSONArray();
            for (int index = 0; index < widths.length(); index++) {
                shots.put(shot(request.getString("url"), widths.getInt(index), request.getBoolean("fullPage"),
                        request.getInt("maxHeight"), request.getLong("settleMs")));
            }
            reply.put("shots", shots);
        } catch (Exception e) {
            reply.put("error", e.getMessage() == null ? e.toString() : e.getMessage());
        }
        post(id, reply);
    }

    /** One picture at `width` CSS pixels, on the main thread, waited for here. */
    private JSONObject shot(String url, int width, boolean fullPage, int maxHeight, long settleMs) throws Exception {
        CountDownLatch done = new CountDownLatch(1);
        Object[] result = new Object[1];
        WebView[] made = new WebView[1];
        main.post(() -> {
            try {
                made[0] = start(url, width, fullPage, maxHeight, settleMs, (value) -> {
                    result[0] = value;
                    done.countDown();
                });
            } catch (Exception e) {
                result[0] = e;
                done.countDown();
            }
        });
        boolean finished = done.await(SHOT_MS, TimeUnit.MILLISECONDS);
        main.post(() -> {
            if (made[0] != null) made[0].destroy();
        });
        if (!finished) throw new IOException("the page did not finish loading within " + (SHOT_MS / 1000) + " seconds");
        if (result[0] instanceof Exception) throw (Exception) result[0];
        return (JSONObject) result[0];
    }

    private interface Done {
        void accept(Object value);
    }

    /** Load the page in a WebView laid out at the width; once it finished and settled, draw it (main thread). */
    private WebView start(String url, int width, boolean fullPage, int maxHeight, long settleMs, Done done) {
        float density = context.getResources().getDisplayMetrics().density;
        int viewport = width < 600 ? 844 : 800;
        WebView view = new WebView(context);
        // No layer of its own: draw() into our canvas renders it in software, without a page-sized buffer.
        view.setBackgroundColor(Color.WHITE);
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMediaPlaybackRequiresUserGesture(true);
        layout(view, Math.round(width * density), Math.round(viewport * density));
        boolean[] settled = {false};
        view.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView page, String loaded) {
                if (settled[0]) return;
                settled[0] = true;
                main.postDelayed(() -> {
                    try {
                        int content = Math.max(viewport, page.getContentHeight());
                        int height = fullPage ? Math.min(content, maxHeight) : viewport;
                        int widthPx = Math.round(width * density);
                        int heightPx = Math.round(height * density);
                        // Off screen, a WebView draws what it has only after its layout changed: a page that fits the
                        // first layout comes out blank. So always change it once, a pixel taller, then to the size,
                        // and give it frames for each.
                        layout(page, widthPx, heightPx + 1);
                        page.invalidate();
                        main.postDelayed(() -> {
                            try {
                                layout(page, widthPx, heightPx);
                                page.invalidate();
                                main.postDelayed(() -> {
                                    try {
                                        done.accept(draw(page, width, height, density));
                                    } catch (Exception e) {
                                        done.accept(e);
                                    }
                                }, 400);
                            } catch (Exception e) {
                                done.accept(e);
                            }
                        }, 200);
                    } catch (Exception e) {
                        done.accept(e);
                    }
                }, settleMs);
            }

            @Override
            public void onReceivedError(WebView page, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame() && !settled[0]) {
                    settled[0] = true;
                    done.accept(new IOException("the page did not load: " + error.getDescription()));
                }
            }
        });
        Map<String, String> headers = new HashMap<>();
        if (url.startsWith(BASE + "/")) headers.put("Authorization", "Bearer " + token.get());
        view.loadUrl(url, headers);
        return view;
    }

    private static void layout(WebView view, int widthPx, int heightPx) {
        view.measure(View.MeasureSpec.makeMeasureSpec(widthPx, View.MeasureSpec.EXACTLY),
                View.MeasureSpec.makeMeasureSpec(heightPx, View.MeasureSpec.EXACTLY));
        view.layout(0, 0, widthPx, heightPx);
    }

    /** The page as a JPEG at CSS-pixel scale: `width` × `height`. */
    private static JSONObject draw(WebView view, int width, int height, float density) throws Exception {
        Bitmap bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
        try {
            Canvas canvas = new Canvas(bitmap);
            canvas.drawColor(Color.WHITE);
            canvas.scale(1f / density, 1f / density);
            view.draw(canvas);
            ByteArrayOutputStream jpeg = new ByteArrayOutputStream();
            bitmap.compress(Bitmap.CompressFormat.JPEG, 82, jpeg);
            return new JSONObject()
                    .put("width", width)
                    .put("height", height)
                    .put("jpeg", Base64.encodeToString(jpeg.toByteArray(), Base64.NO_WRAP));
        } finally {
            bitmap.recycle();
        }
    }

    private void post(String id, JSONObject reply) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(BASE + "/api/phone/renders/" + id).openConnection();
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
        if (code != 200) Log.w(TAG, "render answer: HTTP " + code);
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
