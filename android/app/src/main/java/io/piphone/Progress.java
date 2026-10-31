package io.piphone;

import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.util.Log;
import android.widget.RemoteViews;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.function.BooleanSupplier;
import java.util.function.Supplier;

/**
 * The progress board on the phone (PP-283, GitHub issue #5): what Pi does in every session while another app is in
 * front. It long-polls the server's board (`GET /api/phone/progress`, src/server/progress.ts) and shows it in the
 * always-on pi notification (the title counts, expanded a row per session at work or waiting, each opening its session,
 * and Approve for a simple card), at most every 2 seconds and silently; and, when the owner turned it on and Android
 * lets pi display over other apps, in the floating bubble (ProgressBubble.java).
 */
final class Progress {
    /** Approve on the notification: PiService answers the card it names. */
    static final String ACTION_APPROVE = "io.piphone.PROGRESS_APPROVE";
    static final String EXTRA_APPROVAL = "io.piphone.APPROVAL";
    private static final String TAG = "pi-phone";
    private static final long MIN_GAP_MS = 2_000;
    /** The bubble hides this long after the last run ended, when the owner wants it hidden then. */
    private static final long IDLE_HIDE_MS = 60_000;
    private static final int[] ROWS = { R.id.progress_row0, R.id.progress_row1, R.id.progress_row2, R.id.progress_row3, R.id.progress_row4 };
    private static final int[] DOTS = { R.id.progress_dot0, R.id.progress_dot1, R.id.progress_dot2, R.id.progress_dot3, R.id.progress_dot4 };
    private static final int[] TITLES = { R.id.progress_title0, R.id.progress_title1, R.id.progress_title2, R.id.progress_title3, R.id.progress_title4 };
    private static final int[] DOINGS = { R.id.progress_doing0, R.id.progress_doing1, R.id.progress_doing2, R.id.progress_doing3, R.id.progress_doing4 };
    private static final int[] WHENS = { R.id.progress_when0, R.id.progress_when1, R.id.progress_when2, R.id.progress_when3, R.id.progress_when4 };
    private static final int WORKING = 0xFF9ECE6A;
    private static final int WAITING = 0xFFE0AF68;

    private final Service service;
    private final Supplier<String> token;
    private final BooleanSupplier serverUp;
    private final Supplier<Notification> plain;
    private final Handler main = new Handler(Looper.getMainLooper());
    private ProgressBubble bubble;
    private long lastPost;
    private long lastBusy;
    private boolean showingBoard;

    Progress(Service service, Supplier<String> token, BooleanSupplier serverUp, Supplier<Notification> plain) {
        this.service = service;
        this.token = token;
        this.serverUp = serverUp;
        this.plain = plain;
    }

    /** The board, each new version as the server has it; a poll that fails (the server restarting) is tried again. */
    void loop() {
        long after = -1;
        while (!Thread.currentThread().isInterrupted()) {
            try {
                if (!serverUp.getAsBoolean()) {
                    after = -1;
                    Thread.sleep(2000);
                    continue;
                }
                HttpURLConnection connection = (HttpURLConnection) new URL(
                        "http://127.0.0.1:" + PiService.PORT + "/api/phone/progress?after=" + after
                                + "&lang=" + java.net.URLEncoder.encode(java.util.Locale.getDefault().toLanguageTag(), "UTF-8")).openConnection();
                connection.setConnectTimeout(3000);
                connection.setReadTimeout(70_000);
                connection.setRequestProperty("Authorization", "Bearer " + token.get());
                if (connection.getResponseCode() != 200) throw new java.io.IOException("HTTP " + connection.getResponseCode());
                JSONObject board;
                try (InputStream in = connection.getInputStream()) {
                    board = new JSONObject(PiService.readAll(in));
                }
                after = board.getLong("version");
                // Quiet: at most one change every MIN_GAP_MS, the newest board after the wait.
                long wait = lastPost + MIN_GAP_MS - System.currentTimeMillis();
                if (wait > 0) Thread.sleep(wait);
                show(board);
                lastPost = System.currentTimeMillis();
            } catch (InterruptedException e) {
                return;
            } catch (Exception e) {
                Log.w(TAG, "progress: " + e);
                try {
                    Thread.sleep(3000);
                } catch (InterruptedException stopped) {
                    return;
                }
            }
        }
    }

    private void show(JSONObject board) throws Exception {
        JSONObject settings = board.optJSONObject("settings");
        boolean inNotification = settings == null || settings.optBoolean("notification", true);
        boolean bubbleOn = settings != null && settings.optBoolean("bubble", false);
        boolean hideIdle = settings == null || settings.optBoolean("hideIdle", true);
        int working = board.optInt("working");
        int waiting = board.optInt("waiting");
        NotificationManager manager = service.getSystemService(NotificationManager.class);

        if (inNotification) {
            manager.notify(1, notification(board));
            showingBoard = true;
        } else if (showingBoard) {
            manager.notify(1, plain.get());
            showingBoard = false;
        }

        long now = System.currentTimeMillis();
        if (working + waiting > 0) lastBusy = now;
        boolean allowed = Settings.canDrawOverlays(service);
        boolean wanted = bubbleOn && allowed && (!hideIdle || working + waiting > 0 || now - lastBusy < IDLE_HIDE_MS);
        main.post(() -> {
            if (wanted) {
                if (bubble == null) bubble = new ProgressBubble(service, token);
                bubble.show(working, waiting);
            } else if (bubble != null) {
                bubble.remove();
                bubble = null;
            }
        });
    }

    /** The pi notification as the board: the counts as its title, a row per session expanded, Approve for a simple card. */
    private Notification notification(JSONObject board) throws Exception {
        JSONArray rows = board.getJSONArray("rows");
        String heading = board.getString("heading");
        RemoteViews big = new RemoteViews(service.getPackageName(), R.layout.progress_rows);
        String first = "";
        JSONObject approval = null;
        int approvalSession = -1;

        for (int index = 0; index < ROWS.length; index++) {
            if (index >= rows.length()) {
                big.setViewVisibility(ROWS[index], android.view.View.GONE);
                continue;
            }
            JSONObject row = rows.getJSONObject(index);
            boolean waiting = "waiting".equals(row.getString("state"));
            int session = row.getInt("session");
            big.setViewVisibility(ROWS[index], android.view.View.VISIBLE);
            big.setInt(DOTS[index], "setColorFilter", waiting ? WAITING : WORKING);
            big.setTextViewText(TITLES[index], row.getString("title"));
            big.setTextViewText(DOINGS[index], row.getString("doing"));
            big.setTextViewText(WHENS[index], ago(row.getLong("since")));
            big.setOnClickPendingIntent(ROWS[index], openSession(session, 2000 + index));
            if (index == 0) first = row.getString("title") + ": " + row.getString("doing");
            JSONObject card = row.optJSONObject("approval");
            if (approval == null && card != null && card.optBoolean("simple")) {
                approval = card;
                approvalSession = session;
            }
        }

        int more = board.optInt("more");
        big.setViewVisibility(R.id.progress_more, more > 0 ? android.view.View.VISIBLE : android.view.View.GONE);
        if (more > 0) big.setTextViewText(R.id.progress_more, service.getString(R.string.progress_more, more));

        Notification.Builder builder = new Notification.Builder(service, PiService.RUNTIME_CHANNEL)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(heading)
                .setContentText(first)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setShowWhen(false)
                .setContentIntent(openSession(rows.length() > 0 ? rows.getJSONObject(0).getInt("session") : -1, 1999));

        if (rows.length() > 0) {
            builder.setStyle(new Notification.DecoratedCustomViewStyle()).setCustomBigContentView(big);
        }

        if (approval != null) {
            Intent approve = new Intent(service, PiService.class)
                    .setAction(ACTION_APPROVE)
                    .putExtra(EXTRA_APPROVAL, approval.getString("id"));
            builder.addAction(new Notification.Action.Builder((android.graphics.drawable.Icon) null, service.getString(R.string.progress_approve),
                    PendingIntent.getService(service, 2100, approve, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT)).build());
            builder.addAction(new Notification.Action.Builder((android.graphics.drawable.Icon) null, service.getString(R.string.progress_open_app),
                    openSession(approvalSession, 2101)).build());
        }

        return builder.build();
    }

    /** Opens the app at `session` (none: where it was). */
    private PendingIntent openSession(int session, int code) {
        Intent target = new Intent(service, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        if (session >= 0) target.putExtra(PiService.EXTRA_SESSION, session);
        return PendingIntent.getActivity(service, code, target, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    /** "4 min", "now": how long since `since`. */
    private static String ago(long since) {
        long minutes = Math.max(0, (System.currentTimeMillis() - since) / 60_000);
        if (minutes < 1) return "<1m";
        if (minutes < 60) return minutes + "m";
        return (minutes / 60) + "h";
    }

    /** Approve on the notification: the card it names is allowed, as the app's Approve does. */
    void approve(String id) {
        new Thread(() -> {
            try {
                HttpURLConnection connection = (HttpURLConnection) new URL(
                        "http://127.0.0.1:" + PiService.PORT + "/api/approvals/" + Uri.encode(id)).openConnection();
                connection.setRequestMethod("POST");
                connection.setDoOutput(true);
                connection.setConnectTimeout(3000);
                connection.setRequestProperty("Authorization", "Bearer " + token.get());
                connection.setRequestProperty("Content-Type", "application/json");
                connection.setRequestProperty("X-Pocket", "1");
                try (OutputStream out = connection.getOutputStream()) {
                    out.write("{\"allow\":true}".getBytes(StandardCharsets.UTF_8));
                }
                if (connection.getResponseCode() != 200) Log.w(TAG, "approve: HTTP " + connection.getResponseCode());
            } catch (Exception e) {
                Log.w(TAG, "approve: " + e);
            }
        }, "pi-progress-approve").start();
    }

    /** The service stops: the bubble goes. */
    void stop() {
        main.post(() -> {
            if (bubble != null) {
                bubble.remove();
                bubble = null;
            }
        });
    }
}
