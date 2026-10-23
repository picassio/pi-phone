package io.piphone;

import android.app.Presentation;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Rect;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.util.DisplayMetrics;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.ValueCallback;
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
 * (`POST /api/phone/renders/<id>`).
 *
 * Each page gets a display of its own: a private virtual display of density 1 (a pixel is a CSS pixel), as wide as
 * asked and as tall as the picture may be, with a Presentation window on it. The WebView is laid out at the page's size
 * there and the picture is the frame the GPU composed, as on a screen. Drawing the WebView into a canvas instead
 * (`view.draw`) put its composited layers in the wrong place: a code block's text ran out of its box (PP-10).
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
                        request.getInt("maxHeight"), request.getLong("settleMs"), request.optString("check", "")));
            }
            reply.put("shots", shots);
        } catch (Exception e) {
            reply.put("error", e.getMessage() == null ? e.toString() : e.getMessage());
        }
        post(id, reply);
    }

    /** One picture at `width` CSS pixels, on the main thread, waited for here. */
    private JSONObject shot(String url, int width, boolean fullPage, int maxHeight, long settleMs, String check) throws Exception {
        CountDownLatch done = new CountDownLatch(1);
        Object[] result = new Object[1];
        Stage[] made = new Stage[1];
        main.post(() -> {
            try {
                made[0] = start(url, width, fullPage, maxHeight, settleMs, check, (value) -> {
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
            if (made[0] != null) made[0].release();
        });
        if (!finished) throw new IOException("the page did not finish loading within " + (SHOT_MS / 1000) + " seconds");
        if (result[0] instanceof Exception) throw (Exception) result[0];
        return (JSONObject) result[0];
    }

    private interface Done {
        void accept(Object value);
    }

    /**
     * One page's own display: a private virtual display of density 1, `width` × `height` pixels, whose frames go to an
     * ImageReader and the latest is kept; a Presentation window on it holds the WebView. Private and the app's own, it
     * needs no permission. Made, used and released on the main thread.
     */
    private final class Stage {
        final ImageReader reader;
        final VirtualDisplay display;
        final Presentation window;
        final Pages pages;
        final WebView view;
        Image latest;
        int frames;
        Runnable onFrame;

        Stage(int width, int height) {
            reader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 3);
            reader.setOnImageAvailableListener((source) -> {
                Image image = source.acquireLatestImage();
                if (image == null) return;
                if (latest != null) latest.close();
                latest = image;
                frames++;
                if (onFrame != null) {
                    Runnable next = onFrame;
                    onFrame = null;
                    next.run();
                }
            }, main);
            display = context.getSystemService(DisplayManager.class)
                    .createVirtualDisplay("pi-phone-screenshot", width, height, DisplayMetrics.DENSITY_DEFAULT, reader.getSurface(), 0);
            if (display == null) {
                reader.close();
                throw new IllegalStateException("Android gave no display for screenshots");
            }
            window = new Presentation(context, display.getDisplay());
            pages = new Pages(window.getContext());
            window.setContentView(pages);
            window.show();
            view = new WebView(pages.getContext());
        }

        void release() {
            pages.removeView(view);
            view.destroy();
            window.dismiss();
            display.release();
            if (latest != null) latest.close();
            reader.close();
        }
    }

    /** Load the page in a WebView laid out at the width; once it finished and settled, take its frame (main thread). */
    private Stage start(String url, int width, boolean fullPage, int maxHeight, long settleMs, String check, Done done) {
        int viewport = width < 600 ? 844 : 800;
        Stage stage = new Stage(width, fullPage ? Math.max(viewport, maxHeight) : viewport);
        WebView view = stage.view;
        view.setBackgroundColor(Color.WHITE);
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMediaPlaybackRequiresUserGesture(true);
        stage.pages.addView(view, new ViewGroup.LayoutParams(width, viewport));
        layout(view, width, viewport);
        boolean[] settled = {false};
        view.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView page, String loaded) {
                // The WebView's first, empty page finishing is not the page's (PP-112: a picture of nothing, 0 elements).
                if (settled[0] || loaded == null || !(loaded.startsWith("http:") || loaded.startsWith("https:"))) return;
                settled[0] = true;
                whenLoaded(page, System.currentTimeMillis() + LOAD_MS, () -> main.postDelayed(() -> {
                    try {
                        int content = Math.max(viewport, page.getContentHeight());
                        int height = fullPage ? Math.min(content, maxHeight) : viewport;
                        layout(page, width, height);
                        page.invalidate();
                        main.postDelayed(() -> {
                            // The page measures itself first (layout-check.ts): Pi gets numbers with the picture.
                            ValueCallback<String> measured = (report) -> {
                                int mark = stage.frames;
                                Runnable take = () -> {
                                    try {
                                        JSONObject shot = capture(stage.latest, width, height, !MainActivity.inFront);
                                        if (report != null && !report.equals("null")) {
                                            // evaluateJavascript answers with the value as JSON: here, a JSON string.
                                            shot.put("check", new JSONArray("[" + report + "]").getString(0));
                                        }
                                        done.accept(shot);
                                    } catch (Exception e) {
                                        done.accept(e);
                                    }
                                };
                                // A frame composed after the check, so the picture shows what was measured.
                                stage.onFrame = take;
                                page.invalidate();
                                main.postDelayed(() -> {
                                    if (stage.onFrame != take) return;
                                    stage.onFrame = null;
                                    if (stage.latest != null) take.run();
                                    else done.accept(new IOException("the page was not drawn (no frame came from its display"
                                            + (mark == 0 ? " at all" : "") + ")"));
                                }, 3000);
                            };
                            if (check.isEmpty()) measured.onReceiveValue(null);
                            else page.evaluateJavascript(check, measured);
                        }, 600);
                    } catch (Exception e) {
                        done.accept(e);
                    }
                }, settleMs));
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
        return stage;
    }

    /** How long a finished page may take to say its document is complete. */
    private static final long LOAD_MS = 10_000;

    /**
     * Then, once the page's document is complete at a web address (main thread): onPageFinished may come before the
     * document is there, and a page measured then has no elements and draws white (PP-112). Past `until`, then anyway.
     */
    private void whenLoaded(WebView page, long until, Runnable then) {
        // An SVG file's document has no body.
        page.evaluateJavascript("document.readyState === 'complete' && /^https?:/.test(location.href) && (document.body !== null || !(document instanceof HTMLDocument))", (ready) -> {
            if ("true".equals(ready) || System.currentTimeMillis() > until) then.run();
            else main.postDelayed(() -> whenLoaded(page, until, then), 100);
        });
    }

    /** Lays each page WebView out at its own size, however small the window: what is not on it is drawn anyway. */
    private static final class Pages extends ViewGroup {
        Pages(Context context) {
            super(context);
        }

        @Override
        protected void onMeasure(int widthSpec, int heightSpec) {
            for (int index = 0; index < getChildCount(); index++) {
                View child = getChildAt(index);
                LayoutParams params = child.getLayoutParams();
                child.measure(MeasureSpec.makeMeasureSpec(params.width, MeasureSpec.EXACTLY),
                        MeasureSpec.makeMeasureSpec(params.height, MeasureSpec.EXACTLY));
            }
            setMeasuredDimension(MeasureSpec.getSize(widthSpec), MeasureSpec.getSize(heightSpec));
        }

        @Override
        protected void onLayout(boolean changed, int left, int top, int right, int bottom) {
            for (int index = 0; index < getChildCount(); index++) {
                View child = getChildAt(index);
                child.layout(0, 0, child.getMeasuredWidth(), child.getMeasuredHeight());
            }
        }
    }

    private static void layout(WebView view, int widthPx, int heightPx) {
        ViewGroup.LayoutParams params = view.getLayoutParams();
        params.width = widthPx;
        params.height = heightPx;
        view.setLayoutParams(params);
        view.measure(View.MeasureSpec.makeMeasureSpec(widthPx, View.MeasureSpec.EXACTLY),
                View.MeasureSpec.makeMeasureSpec(heightPx, View.MeasureSpec.EXACTLY));
        view.layout(0, 0, widthPx, heightPx);
    }

    /** The tallest part of a picture: models take no image over 2000 pixels a side once a conversation holds many. */
    private static final int PART = 2000;

    /**
     * The frame's top `width` × `height` pixels (CSS pixels: the display has density 1) as JPEGs, in parts from the top,
     * each at most PART tall. All white with the app off screen is an error, not a picture: Android may have stopped
     * drawing, and a blank picture would pass for a blank page.
     */
    private static JSONObject capture(Image frame, int width, int height, boolean offScreen) throws Exception {
        if (frame == null) throw new IOException("the page was not drawn (no frame came from its display)");
        Image.Plane plane = frame.getPlanes()[0];
        int stride = plane.getRowStride() / plane.getPixelStride();
        Bitmap whole = Bitmap.createBitmap(stride, frame.getHeight(), Bitmap.Config.ARGB_8888);
        Bitmap bitmap = null;
        try {
            whole.copyPixelsFromBuffer(plane.getBuffer().rewind());
            bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
            Canvas canvas = new Canvas(bitmap);
            canvas.drawColor(Color.WHITE);
            canvas.drawBitmap(whole, new Rect(0, 0, width, height), new Rect(0, 0, width, height), null);
            if (offScreen && allWhite(bitmap)) {
                throw new IOException("The page came out all white while pi-phone was not on screen (in the background, or "
                        + "with the screen off), where Android may not draw it. Ask the person to open pi-phone, then try "
                        + "again: if it is still white, the page is.");
            }
            JSONArray parts = new JSONArray();
            for (int top = 0; top < height; top += PART) {
                Bitmap part = top == 0 && height <= PART ? bitmap : Bitmap.createBitmap(bitmap, 0, top, width, Math.min(PART, height - top));
                ByteArrayOutputStream jpeg = new ByteArrayOutputStream();
                part.compress(Bitmap.CompressFormat.JPEG, 82, jpeg);
                if (part != bitmap) part.recycle();
                parts.put(Base64.encodeToString(jpeg.toByteArray(), Base64.NO_WRAP));
            }
            return new JSONObject()
                    .put("width", width)
                    .put("height", height)
                    .put("parts", parts);
        } finally {
            whole.recycle();
            if (bitmap != null) bitmap.recycle();
        }
    }

    /** Every pixel white, row by row. */
    private static boolean allWhite(Bitmap bitmap) {
        int width = bitmap.getWidth();
        int[] row = new int[width];
        for (int y = 0; y < bitmap.getHeight(); y++) {
            bitmap.getPixels(row, 0, width, 0, y, width, 1);
            for (int pixel : row) {
                if (pixel != Color.WHITE) return false;
            }
        }
        return true;
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
