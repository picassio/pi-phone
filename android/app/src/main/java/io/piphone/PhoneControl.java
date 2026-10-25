package io.piphone;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.annotation.TargetApi;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.Rect;
import android.graphics.drawable.Icon;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.util.Base64;
import android.util.DisplayMetrics;
import android.util.Log;
import android.view.Display;
import android.hardware.display.DisplayManager;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.text.DateFormat;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Date;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ForkJoinPool;
import java.util.concurrent.RecursiveTask;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BooleanSupplier;
import java.util.function.Supplier;

/**
 * Pi controls this phone (src/server/phone-control.ts, PP-141): long-polls the server for what to do
 * (`GET /api/phone/control`), does it through pi-phone's accessibility service (PiAccessibility.java), and answers
 * (`POST /api/phone/control/<id>`), as PiBrowser.java does for Pi's browser.
 *
 * Ops: status, front (the app in front), apps (launchable apps), tree (the screen's windows and nodes), tap, press,
 * swipe, type, button, open, shot (a JPEG of the screen, Android 11+), banner (show or hide the session's banner and
 * notification). Every op but status, apps and banner carries the session's scope (`allowed` packages with the home
 * screen, the `never` patterns, `until`), and this checks it again here, against the app in front now: no session, a
 * session that ended or was stopped on the phone, pi-phone itself, a Never app or one outside the session is refused;
 * the session's banner is shown again first when it is not up (pi-phone's process started again in a session).
 * A password field's text is never read; a tree of an app that may not be read has no nodes.
 *
 * The tree, the gestures, the text input and the screenshot are ported from lycorp-jp/sim-use's bridge (Apache-2.0,
 * Copyright 2026 LY Corporation): TreeHandler.kt (a parallel walk, as each getChild() is a Binder call),
 * GestureHandler.kt (dispatchGesture), InputHandler.kt (ACTION_SET_TEXT; a hint shown as text is no text),
 * CaptureHandler.kt (takeScreenshot) and KeyboardStateHandler.kt (the input method's window).
 */
final class PhoneControl {

    private static final String TAG = "pi-phone-control";
    private static final String BASE = "http://127.0.0.1:" + PiService.PORT;
    static final String CHANNEL = "pi-phone-control";
    private static final int NOTIFICATION = 7;
    /** The longest side of a screenshot, in pixels: models take none larger once a conversation holds many. */
    private static final int PICTURE_MAX = 2000;
    /** At most this many nodes in a tree (a web page in an app can have thousands). */
    private static final int MAX_NODES = 3000;

    static final int CLICKABLE = 1, LONG_CLICKABLE = 2, SCROLLABLE = 4, FOCUSABLE = 8, FOCUSED = 16, ENABLED = 32,
            CHECKABLE = 64, CHECKED = 128, SELECTED = 256, PASSWORD = 512, VISIBLE = 1024, EDITABLE = 2048, COLLECTION = 4096;

    private static final ForkJoinPool POOL = new ForkJoinPool(Math.min(32, Runtime.getRuntime().availableProcessors() * 4));

    private final Context context;
    private final Supplier<String> token;
    private final BooleanSupplier serving;
    private final Handler main = new Handler(Looper.getMainLooper());
    /** The end of the session the banner shows (0: none). */
    private volatile long shownUntil = 0;
    /** The end of the session the owner stopped on the phone: refused here even before the server hears of it. */
    private volatile long stoppedUntil = -1;

    PhoneControl(Context context, Supplier<String> token, BooleanSupplier serving) {
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
                HttpURLConnection connection = (HttpURLConnection) new URL(BASE + "/api/phone/control?after=" + after).openConnection();
                connection.setConnectTimeout(3000);
                connection.setReadTimeout(70_000);
                connection.setRequestProperty("Authorization", "Bearer " + token.get());
                if (connection.getResponseCode() != 200) throw new IOException("HTTP " + connection.getResponseCode());
                JSONObject answer;
                try (InputStream in = connection.getInputStream()) {
                    answer = new JSONObject(PiService.readAll(in));
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
                Log.w(TAG, "phone control: " + e);
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
        JSONObject reply;
        try {
            reply = run(request);
        } catch (Exception | OutOfMemoryError e) {
            // Never the request itself in a log: what Pi types is in it.
            reply = new JSONObject().put("error", e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage());
        }
        post("/api/phone/control/" + id, reply);
    }

    private JSONObject run(JSONObject request) throws Exception {
        String op = request.getString("op");
        if (op.equals("status")) return status();
        if (op.equals("apps")) return apps();
        if (op.equals("label")) return label(request.getString("package"));
        if (op.equals("banner")) return banner(request);
        PiAccessibility service = PiAccessibility.get();
        if (service == null) throw new IllegalStateException("pi-phone's accessibility service is off: turn it on in Android's Accessibility settings");
        switch (op) {
            case "front": {
                String front = foreground(service);
                return withHidden(service, new JSONObject().put("foreground", front == null ? JSONObject.NULL : front), front);
            }
            case "tree":
                scoped(request, service, false);
                return tree(service, request);
            case "tap": {
                scoped(request, service, true);
                float x = (float) request.getDouble("x"), y = (float) request.getDouble("y");
                notOnBanner(service, x, y);
                gesture(service, x, y, x, y, 60);
                return new JSONObject();
            }
            case "press": {
                scoped(request, service, true);
                float x = (float) request.getDouble("x"), y = (float) request.getDouble("y");
                notOnBanner(service, x, y);
                gesture(service, x, y, x, y, Math.max(400, Math.min(5000, request.optLong("ms", 800))));
                return new JSONObject();
            }
            case "swipe": {
                scoped(request, service, true);
                float x = (float) request.getDouble("x"), y = (float) request.getDouble("y");
                notOnBanner(service, x, y);
                gesture(service, x, y, (float) request.getDouble("x2"), (float) request.getDouble("y2"),
                        Math.max(50, Math.min(5000, request.optLong("ms", 350))));
                return new JSONObject();
            }
            case "type":
                scoped(request, service, true);
                type(service, request);
                return new JSONObject();
            case "button": {
                String name = request.getString("name");
                // Back and home get out of any app; the others act in the app in front.
                scoped(request, service, !(name.equals("back") || name.equals("home")));
                int action;
                if (name.equals("back")) action = AccessibilityService.GLOBAL_ACTION_BACK;
                else if (name.equals("home")) action = AccessibilityService.GLOBAL_ACTION_HOME;
                else if (name.equals("recents")) action = AccessibilityService.GLOBAL_ACTION_RECENTS;
                else if (name.equals("notifications")) action = AccessibilityService.GLOBAL_ACTION_NOTIFICATIONS;
                else if (name.equals("quick_settings")) action = AccessibilityService.GLOBAL_ACTION_QUICK_SETTINGS;
                else throw new IllegalArgumentException("no button " + name);
                if (!service.performGlobalAction(action)) throw new IllegalStateException("Android did not press " + name);
                return new JSONObject();
            }
            case "open": {
                scoped(request, service, false);
                String name = request.getString("package");
                String why = refusal(name, request);
                if (why != null) throw new IllegalStateException(why);
                Intent launch = context.getPackageManager().getLaunchIntentForPackage(name);
                if (launch == null) throw new IllegalStateException(name + " has nothing to open");
                launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED);
                // From the accessibility service: Android lets a bound accessibility service start activities from the background.
                service.startActivity(launch);
                return new JSONObject();
            }
            case "shot":
                scoped(request, service, true);
                return shot(service, request.optInt("quality", 80));
            default:
                throw new IllegalArgumentException("unknown request " + op);
        }
    }

    // ─── Scope ──────────────────────────────────────────────────────────────

    /**
     * The request's session: there, not over, not stopped on the phone; with `front`, the app in front now may be
     * touched in it.
     */
    private void scoped(JSONObject request, PiAccessibility service, boolean front) throws Exception {
        JSONArray allowed = request.optJSONArray("allowed");
        long until = request.optLong("until", 0);
        if (allowed == null || until <= System.currentTimeMillis()) throw new IllegalStateException("no phone control session is active");
        if (until == stoppedUntil) throw new IllegalStateException("the owner pressed Stop on the phone: this session is over");
        // The owner sees the banner whenever Pi reads or acts: after pi-phone's process or the service started again in
        // a session (the server keeps it), the banner is shown again before anything else.
        if (shownUntil != until) showBanner(service, until, request.optString("apps", ""));
        if (!front) return;
        String why = refusal(foreground(service), request);
        if (why != null) throw new IllegalStateException(why);
    }

    /** Why the session may not touch `name`, or null when it may. */
    private String refusal(String name, JSONObject request) throws JSONException {
        if (name == null || name.isEmpty()) return "Android reports no app in front";
        if (name.equals(context.getPackageName())) return "pi-phone itself is in front: Pi never controls pi-phone";
        JSONArray never = request.optJSONArray("never");
        if (never != null) {
            for (int index = 0; index < never.length(); index++) {
                String pattern = never.getString(index);
                if (pattern.endsWith("*") ? name.startsWith(pattern.substring(0, pattern.length() - 1)) : name.equals(pattern)) {
                    return name + " is on the Never list";
                }
            }
        }
        JSONArray allowed = request.getJSONArray("allowed");
        for (int index = 0; index < allowed.length(); index++) {
            if (name.equals(allowed.getString(index))) return null;
        }
        return name + " is not in this session";
    }

    /**
     * The title of the app window in front when Android hides its content from accessibility services: a screen marked
     * sensitive (Android 14 and later: permission and default-app screens), whose root it gives as null, so its app is not
     * known either. Null when no app window is in front, or its content shows.
     */
    private static String hiddenTitle(AccessibilityService service) {
        AccessibilityWindowInfo top = null;
        for (AccessibilityWindowInfo window : service.getWindows()) {
            if (window.getType() == AccessibilityWindowInfo.TYPE_APPLICATION && (top == null || window.getLayer() > top.getLayer())) top = window;
        }
        if (top == null) return null;
        AccessibilityNodeInfo root = top.getRoot();
        if (root != null) {
            recycle(root);
            return null;
        }
        CharSequence title = top.getTitle();
        return title == null ? "" : title.toString();
    }

    /** `reply` with `hidden` (the window's title) when nothing is known in front but a hidden app window is there. */
    private static JSONObject withHidden(AccessibilityService service, JSONObject reply, String front) throws JSONException {
        if (front != null) return reply;
        String hidden = hiddenTitle(service);
        return hidden == null ? reply : reply.put("hidden", hidden);
    }

    /** The package of the app in front: the active window's, or the top app window's while Android has no active one. */
    private static String foreground(AccessibilityService service) {
        AccessibilityNodeInfo root = service.getRootInActiveWindow();
        if (root != null) {
            CharSequence name = root.getPackageName();
            recycle(root);
            if (name != null) return name.toString();
        }
        AccessibilityWindowInfo top = null;
        for (AccessibilityWindowInfo window : service.getWindows()) {
            if (window.getType() == AccessibilityWindowInfo.TYPE_APPLICATION && (top == null || window.getLayer() > top.getLayer())) top = window;
        }
        if (top == null) return null;
        AccessibilityNodeInfo topRoot = top.getRoot();
        if (topRoot == null) return null;
        CharSequence name = topRoot.getPackageName();
        recycle(topRoot);
        return name == null ? null : name.toString();
    }

    private static void notOnBanner(PiAccessibility service, float x, float y) {
        Rect banner = service.bannerRect();
        if (banner != null && banner.contains(Math.round(x), Math.round(y))) {
            throw new IllegalStateException("that point is on pi-phone's banner at the top of the screen");
        }
    }

    // ─── Reading ────────────────────────────────────────────────────────────

    private JSONObject status() throws JSONException {
        PiAccessibility service = PiAccessibility.get();
        String front = service == null ? null : foreground(service);
        String launcher = launcher();
        return new JSONObject()
                .put("enabled", service != null)
                .put("android", Build.VERSION.SDK_INT)
                .put("screenshot", Build.VERSION.SDK_INT >= 30)
                .put("foreground", front == null ? JSONObject.NULL : front)
                .put("launcher", launcher == null ? JSONObject.NULL : launcher)
                .put("unrestricted", ((PowerManager) context.getSystemService(Context.POWER_SERVICE)).isIgnoringBatteryOptimizations(context.getPackageName()));
    }

    /** The home screen's package; null while the person has not chosen one (Android's chooser answers). */
    private String launcher() {
        ResolveInfo home = context.getPackageManager().resolveActivity(
                new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME), PackageManager.MATCH_DEFAULT_ONLY);
        if (home == null || home.activityInfo == null || "android".equals(home.activityInfo.packageName)) return null;
        return home.activityInfo.packageName;
    }

    /**
     * An installed app's name, launchable or not: an app a session follows into may have no icon of its own (Samsung's
     * Device care, which Settings' Battery opens). An app not installed answers with an error.
     */
    private JSONObject label(String name) throws Exception {
        PackageManager packages = context.getPackageManager();
        return new JSONObject().put("label", String.valueOf(packages.getApplicationLabel(packages.getApplicationInfo(name, 0))));
    }

    private JSONObject apps() throws JSONException {
        PackageManager packages = context.getPackageManager();
        // Every launchable app: pi-phone targets SDK 28, so Android 11's package visibility does not hide any.
        List<ResolveInfo> found = packages.queryIntentActivities(new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER), 0);
        Map<String, String> byPackage = new LinkedHashMap<>();
        for (ResolveInfo each : found) {
            String name = each.activityInfo.packageName;
            if (!byPackage.containsKey(name)) byPackage.put(name, String.valueOf(each.loadLabel(packages)));
        }
        List<Map.Entry<String, String>> sorted = new ArrayList<>(byPackage.entrySet());
        Collections.sort(sorted, (a, b) -> a.getValue().compareToIgnoreCase(b.getValue()));
        JSONArray apps = new JSONArray();
        for (Map.Entry<String, String> each : sorted) apps.put(new JSONObject().put("label", each.getValue()).put("package", each.getKey()));
        return new JSONObject().put("apps", apps);
    }

    /**
     * The screen: its size, the app in front, whether the keyboard is up, and its windows; the nodes only of the windows
     * of the app in front, and only when the session may read it.
     */
    private JSONObject tree(PiAccessibility service, JSONObject request) throws Exception {
        String front = foreground(service);
        boolean readable = refusal(front, request) == null;
        DisplayMetrics metrics = new DisplayMetrics();
        // From DisplayManager: a service's context has no display of its own to ask.
        context.getSystemService(DisplayManager.class).getDisplay(Display.DEFAULT_DISPLAY).getRealMetrics(metrics);
        JSONArray windows = new JSONArray();
        boolean keyboard = false;
        AtomicInteger count = new AtomicInteger(0);
        for (AccessibilityWindowInfo window : service.getWindows()) {
            int type = window.getType();
            if (type == AccessibilityWindowInfo.TYPE_INPUT_METHOD) keyboard = true;
            AccessibilityNodeInfo root = window.getRoot();
            String name = "";
            if (root != null && root.getPackageName() != null) name = root.getPackageName().toString();
            JSONObject one = new JSONObject()
                    .put("id", window.getId())
                    .put("type", typeName(type))
                    .put("package", name)
                    .put("layer", window.getLayer())
                    .put("active", window.isActive());
            if (root != null) {
                try {
                    if (readable && type == AccessibilityWindowInfo.TYPE_APPLICATION && name.equals(front)) {
                        JSONObject built = POOL.invoke(new Walk(root, count));
                        if (built != null) one.put("root", built);
                    }
                } finally {
                    recycle(root);
                }
            }
            windows.put(one);
        }
        return withHidden(service, new JSONObject()
                .put("display", new JSONObject().put("width", metrics.widthPixels).put("height", metrics.heightPixels))
                .put("foreground", front == null ? JSONObject.NULL : front)
                .put("keyboard", keyboard)
                .put("windows", windows), front);
    }

    private static String typeName(int type) {
        switch (type) {
            case AccessibilityWindowInfo.TYPE_APPLICATION: return "application";
            case AccessibilityWindowInfo.TYPE_INPUT_METHOD: return "input_method";
            case AccessibilityWindowInfo.TYPE_SYSTEM: return "system";
            case AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY: return "accessibility_overlay";
            default: return "other";
        }
    }

    /** A node and what is under it, its children fetched in parallel (sim-use's TreeHandler). */
    private static final class Walk extends RecursiveTask<JSONObject> {
        private final AccessibilityNodeInfo info;
        private final AtomicInteger count;

        Walk(AccessibilityNodeInfo info, AtomicInteger count) {
            this.info = info;
            this.count = count;
        }

        @Override
        protected JSONObject compute() {
            try {
                return node(info, count);
            } catch (JSONException e) {
                throw new IllegalStateException(e);
            }
        }
    }

    /** The node as the server reads it (`phone-outline.ts`: short keys, empty ones left out); null for an empty leaf. */
    private static JSONObject node(AccessibilityNodeInfo info, AtomicInteger count) throws JSONException {
        count.incrementAndGet();
        Rect bounds = new Rect();
        info.getBoundsInScreen(bounds);
        List<Walk> tasks = new ArrayList<>();
        List<AccessibilityNodeInfo> children = new ArrayList<>();
        List<Integer> places = new ArrayList<>();
        JSONArray kids = new JSONArray();
        RuntimeException failed = null;
        try {
            if (count.get() < MAX_NODES) {
                for (int index = 0; index < info.getChildCount(); index++) {
                    AccessibilityNodeInfo child = info.getChild(index);
                    if (child == null) continue;
                    Walk task = new Walk(child, count);
                    task.fork();
                    tasks.add(task);
                    children.add(child);
                    places.add(index);
                }
            }
        } catch (RuntimeException e) {
            failed = e;
        }
        // Every task is joined before any child is recycled: none is read after.
        for (int at = 0; at < tasks.size(); at++) {
            try {
                JSONObject built = tasks.get(at).join();
                if (built != null && failed == null) {
                    if (places.get(at) != kids.length()) built.put("i", places.get(at));
                    kids.put(built);
                }
            } catch (RuntimeException e) {
                if (failed == null) failed = e;
            }
        }
        for (AccessibilityNodeInfo child : children) recycle(child);
        if (failed != null) throw failed;
        if ((bounds.width() <= 0 || bounds.height() <= 0) && kids.length() == 0) return null;

        int flags = 0;
        if (info.isClickable()) flags |= CLICKABLE;
        if (info.isLongClickable()) flags |= LONG_CLICKABLE;
        if (info.isScrollable()) flags |= SCROLLABLE;
        if (info.isFocusable()) flags |= FOCUSABLE;
        if (info.isFocused()) flags |= FOCUSED;
        if (info.isEnabled()) flags |= ENABLED;
        if (info.isCheckable()) flags |= CHECKABLE;
        if (info.isChecked()) flags |= CHECKED;
        if (info.isSelected()) flags |= SELECTED;
        if (info.isPassword()) flags |= PASSWORD;
        if (info.isVisibleToUser()) flags |= VISIBLE;
        if (info.isEditable()) flags |= EDITABLE;
        if (info.getCollectionInfo() != null) flags |= COLLECTION;

        JSONObject out = new JSONObject();
        put(out, "c", info.getClassName());
        put(out, "r", info.getViewIdResourceName());
        // A password field's text never leaves the phone.
        if (!info.isPassword()) put(out, "t", info.getText());
        put(out, "d", info.getContentDescription());
        put(out, "h", info.getHintText());
        if (Build.VERSION.SDK_INT >= 30) put(out, "s", stateOf(info));
        out.put("b", new JSONArray().put(bounds.left).put(bounds.top).put(bounds.right).put(bounds.bottom));
        out.put("f", flags);
        if (kids.length() > 0) out.put("k", kids);
        return out;
    }

    @TargetApi(30)
    private static CharSequence stateOf(AccessibilityNodeInfo info) {
        return info.getStateDescription();
    }

    private static void put(JSONObject out, String key, CharSequence value) throws JSONException {
        if (value == null || value.length() == 0) return;
        String text = value.toString();
        out.put(key, text.length() > 500 ? text.substring(0, 500) : text);
    }

    @SuppressWarnings("deprecation")
    private static void recycle(AccessibilityNodeInfo node) {
        try {
            node.recycle();
        } catch (IllegalStateException alreadyRecycled) {
            // recycle() does nothing from Android 13, and earlier throws for a node recycled already.
        }
    }

    // ─── Acting ─────────────────────────────────────────────────────────────

    /** One stroke from (x1, y1) to (x2, y2) over `ms`, waited for (sim-use's GestureHandler, with its result). */
    private static void gesture(AccessibilityService service, float x1, float y1, float x2, float y2, long ms) throws Exception {
        if (x1 < 0 || y1 < 0 || x2 < 0 || y2 < 0) throw new IllegalArgumentException("a point is off the screen");
        Path path = new Path();
        path.moveTo(x1, y1);
        path.lineTo(x2, y2);
        GestureDescription gesture = new GestureDescription.Builder()
                .addStroke(new GestureDescription.StrokeDescription(path, 0, ms))
                .build();
        CountDownLatch done = new CountDownLatch(1);
        AtomicBoolean completed = new AtomicBoolean(false);
        boolean sent = service.dispatchGesture(gesture, new AccessibilityService.GestureResultCallback() {
            @Override
            public void onCompleted(GestureDescription description) {
                completed.set(true);
                done.countDown();
            }

            @Override
            public void onCancelled(GestureDescription description) {
                done.countDown();
            }
        }, null);
        if (!sent) throw new IllegalStateException("Android did not take the gesture");
        if (!done.await(ms + 5000, TimeUnit.MILLISECONDS)) throw new IOException("the gesture did not finish in time");
        if (!completed.get()) throw new IllegalStateException("Android cancelled the gesture (the screen changed under it)");
    }

    /** Text into a field: the node the server names (checked to be where it was read), or the focused one. */
    private void type(PiAccessibility service, JSONObject request) throws Exception {
        JSONObject ref = request.optJSONObject("node");
        AccessibilityNodeInfo field;
        if (ref == null) {
            AccessibilityNodeInfo root = service.getRootInActiveWindow();
            if (root == null) throw new IllegalStateException("Android reports no app in front");
            field = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
            recycle(root);
            if (field == null) throw new IllegalStateException("no field has the focus: name one by its number");
        } else {
            field = find(service, ref);
        }
        try {
            String why = refusal(field.getPackageName() == null ? null : field.getPackageName().toString(), request);
            if (why != null) throw new IllegalStateException(why);
            if (!field.isEditable()) throw new IllegalStateException("that element is not a field to type into");
            if (field.isPassword()) throw new IllegalStateException("that is a password field: Pi does not type into it; the owner types it on the phone");
            if (!field.isFocused()) field.performAction(AccessibilityNodeInfo.ACTION_FOCUS);
            String text = request.getString("text");
            CharSequence now = field.getText();
            CharSequence hint = field.getHintText();
            String current = now == null ? "" : now.toString();
            boolean replace = request.optBoolean("clear", true) || (hint != null && current.equals(hint.toString()));
            String value = replace ? text : current + text;
            Bundle arguments = new Bundle();
            arguments.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, value);
            if (!field.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, arguments)) throw new IllegalStateException("the field did not take the text");
            // ACTION_SET_TEXT puts the caret at the start: at the end, as a person's typing leaves it.
            Bundle selection = new Bundle();
            selection.putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, value.length());
            selection.putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, value.length());
            field.performAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, selection);
            if (request.optBoolean("submit", false)) enter(field);
        } finally {
            recycle(field);
        }
    }

    @TargetApi(30)
    private static void enter(AccessibilityNodeInfo field) {
        if (Build.VERSION.SDK_INT < 30) throw new IllegalStateException("pressing Enter needs Android 11 or later: tap the app's own button");
        if (!field.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.getId())) {
            throw new IllegalStateException("the field did not take Enter: tap the app's own button");
        }
    }

    /** The node at `ref` (window id, child indices, bounds as read): or why the screen changed since. */
    private static AccessibilityNodeInfo find(AccessibilityService service, JSONObject ref) throws JSONException {
        int windowId = ref.getInt("w");
        JSONArray path = ref.getJSONArray("p");
        JSONArray bounds = ref.getJSONArray("b");
        AccessibilityNodeInfo at = null;
        for (AccessibilityWindowInfo window : service.getWindows()) {
            if (window.getId() == windowId) at = window.getRoot();
        }
        if (at == null) throw new IllegalStateException("the screen changed since it was read: read it again");
        for (int step = 0; step < path.length(); step++) {
            int index = path.getInt(step);
            AccessibilityNodeInfo next = index < at.getChildCount() ? at.getChild(index) : null;
            recycle(at);
            if (next == null) throw new IllegalStateException("the screen changed since it was read: read it again");
            at = next;
        }
        Rect now = new Rect();
        at.getBoundsInScreen(now);
        if (now.left != bounds.getInt(0) || now.top != bounds.getInt(1) || now.right != bounds.getInt(2) || now.bottom != bounds.getInt(3)) {
            recycle(at);
            throw new IllegalStateException("that element moved since the screen was read: read it again");
        }
        return at;
    }

    /** A JPEG of the screen, at most PICTURE_MAX on its longest side, with the screen's size (sim-use's CaptureHandler). */
    @TargetApi(30)
    private JSONObject shot(PiAccessibility service, int quality) throws Exception {
        if (Build.VERSION.SDK_INT < 30) throw new IllegalStateException("screenshots need Android 11 or later");
        CountDownLatch done = new CountDownLatch(1);
        AtomicReference<Bitmap> taken = new AtomicReference<>(null);
        AtomicReference<String> failure = new AtomicReference<>(null);
        service.takeScreenshot(Display.DEFAULT_DISPLAY, service.getMainExecutor(), new AccessibilityService.TakeScreenshotCallback() {
            @Override
            public void onSuccess(AccessibilityService.ScreenshotResult result) {
                try {
                    Bitmap hardware = Bitmap.wrapHardwareBuffer(result.getHardwareBuffer(), result.getColorSpace());
                    if (hardware == null) {
                        failure.set("Android gave a screenshot that cannot be read");
                    } else {
                        taken.set(hardware.copy(Bitmap.Config.ARGB_8888, false));
                        hardware.recycle();
                    }
                } catch (OutOfMemoryError e) {
                    failure.set("not enough memory for the screenshot");
                } finally {
                    result.getHardwareBuffer().close();
                    done.countDown();
                }
            }

            @Override
            public void onFailure(int code) {
                failure.set("Android refused the screenshot (code " + code + "; it takes one a second at most)");
                done.countDown();
            }
        });
        if (!done.await(10, TimeUnit.SECONDS)) throw new IOException("the screenshot did not come in time");
        Bitmap whole = taken.get();
        if (whole == null) throw new IllegalStateException(failure.get() == null ? "no screenshot" : failure.get());
        Bitmap out = null;
        try {
            int width = whole.getWidth();
            int height = whole.getHeight();
            float scale = Math.min(1f, PICTURE_MAX / (float) Math.max(width, height));
            int outWidth = Math.max(1, Math.round(width * scale));
            int outHeight = Math.max(1, Math.round(height * scale));
            out = Bitmap.createBitmap(outWidth, outHeight, Bitmap.Config.ARGB_8888);
            new Canvas(out).drawBitmap(whole, new Rect(0, 0, width, height), new Rect(0, 0, outWidth, outHeight), new Paint(Paint.FILTER_BITMAP_FLAG));
            ByteArrayOutputStream encoded = new ByteArrayOutputStream();
            out.compress(Bitmap.CompressFormat.JPEG, Math.max(30, Math.min(95, quality)), encoded);
            // The screen's size, not the picture's: marks and points are in screen pixels.
            return new JSONObject()
                    .put("jpeg", Base64.encodeToString(encoded.toByteArray(), Base64.NO_WRAP))
                    .put("width", width)
                    .put("height", height);
        } finally {
            whole.recycle();
            if (out != null) out.recycle();
        }
    }

    // ─── The banner, the notification, and Stop ─────────────────────────────

    private interface Work {
        void run() throws Exception;
    }

    /** Run on the main thread and wait for it, with what it threw. */
    private void onMain(Work work) throws Exception {
        CountDownLatch done = new CountDownLatch(1);
        AtomicReference<Exception> failed = new AtomicReference<>(null);
        main.post(() -> {
            try {
                work.run();
            } catch (Exception e) {
                failed.set(e);
            }
            done.countDown();
        });
        if (!done.await(10, TimeUnit.SECONDS)) throw new IOException("the phone's screen did not answer in time");
        if (failed.get() != null) throw failed.get();
    }

    private final Runnable expire = () -> {
        if (shownUntil != 0 && System.currentTimeMillis() >= shownUntil) hideNow();
    };

    private JSONObject banner(JSONObject request) throws Exception {
        if (!request.optBoolean("show", false)) {
            onMain(this::hideNow);
            return new JSONObject();
        }
        PiAccessibility service = PiAccessibility.get();
        if (service == null) throw new IllegalStateException("pi-phone's accessibility service is off: turn it on in Android's Accessibility settings");
        showBanner(service, request.getLong("until"), request.optString("apps", ""));
        return new JSONObject();
    }

    /** The session's banner and notification up until `until`, taken down by themselves then. */
    private void showBanner(PiAccessibility service, long until, String apps) throws Exception {
        onMain(() -> {
            service.showBanner(until, this::stopFromPhone);
            notification(until, apps);
            shownUntil = until;
            main.removeCallbacks(expire);
            main.postDelayed(expire, Math.max(0, until - System.currentTimeMillis()) + 500);
        });
    }

    /** The session's notification, with Stop: it stays until the session ends (main thread). */
    private void notification(long until, String apps) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel(CHANNEL, context.getString(R.string.channel_phone_control), NotificationManager.IMPORTANCE_DEFAULT));
        PendingIntent stop = PendingIntent.getForegroundService(context, 2,
                new Intent(context, PiService.class).setAction(PiService.ACTION_PHONE_STOP),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        PendingIntent open = PendingIntent.getActivity(context, 3, new Intent(context, MainActivity.class), PendingIntent.FLAG_IMMUTABLE);
        String time = DateFormat.getTimeInstance(DateFormat.SHORT).format(new Date(until));
        Notification notification = new Notification.Builder(context, CHANNEL)
                .setContentTitle(context.getString(R.string.phone_control_title))
                .setContentText(context.getString(R.string.phone_control_text, apps, time))
                .setSmallIcon(R.drawable.ic_notification)
                .setContentIntent(open)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .addAction(new Notification.Action.Builder(Icon.createWithResource(context, R.drawable.ic_notification),
                        context.getString(R.string.phone_control_stop), stop).build())
                .build();
        manager.notify(NOTIFICATION, notification);
    }

    /** The banner and the notification down (main thread). */
    private void hideNow() {
        shownUntil = 0;
        main.removeCallbacks(expire);
        PiAccessibility service = PiAccessibility.get();
        if (service != null) service.hideBanner();
        context.getSystemService(NotificationManager.class).cancel(NOTIFICATION);
    }

    /**
     * Stop, from the banner or the notification: down at once, the session refused here from now on, and the server
     * told (`POST /api/phone-control/stop`), tried a few times while it does not answer.
     */
    void stopFromPhone() {
        stoppedUntil = shownUntil;
        main.post(this::hideNow);
        new Thread(() -> {
            for (int attempt = 0; attempt < 5; attempt++) {
                try {
                    post("/api/phone-control/stop", new JSONObject().put("device", "phone").put("from", "phone"));
                    return;
                } catch (Exception e) {
                    Log.w(TAG, "stop not sent: " + e);
                    try {
                        Thread.sleep(2000);
                    } catch (InterruptedException stopped) {
                        return;
                    }
                }
            }
        }, "pi-phone-stop").start();
    }

    private void post(String path, JSONObject body) throws IOException {
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
        if (code != 200) throw new IOException("HTTP " + code + " for " + path);
    }
}
