package io.piphone;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.IBinder;
import android.os.PowerManager;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Map;

/**
 * Foreground service that owns the server process (DESIGN.md section 2). Extracts the APK's runtime when the APK is
 * new, then runs `node runtime/src/server/main.ts`, and starts it again when it exits with code 75 (the app asked for
 * a restart) or after applying a downloaded update. Any other exit is a failure the activity shows, with the log.
 */
public final class PiService extends Service {

    static final int PORT = 8787;
    private static final int RESTART_CODE = 75;
    private static final String CHANNEL = "pi-runtime";
    /** Sessions that finished, failed, or ask for an approval (phone-events.ts), and files saved to Downloads. */
    static final String EVENTS_CHANNEL = "pi-events";
    /** The session a notification opens: MainActivity reads it. */
    static final String EXTRA_SESSION = "io.piphone.SESSION";
    private static final String TAG = "pi-phone";
    private static final String ACTION_UPDATE = "io.piphone.UPDATE";

    enum State { STOPPED, INSTALLING, STARTING, RUNNING, UPDATING, FAILED }

    /** Downloaded parts waiting to be swapped in: each file is a gzipped tar of its part, with its version. */
    static final class Update {
        final File rootfs;
        final String rootfsVersion;
        final File runtime;
        final String runtimeVersion;

        Update(File rootfs, String rootfsVersion, File runtime, String runtimeVersion) {
            this.rootfs = rootfs;
            this.rootfsVersion = rootfsVersion;
            this.runtime = runtime;
            this.runtimeVersion = runtimeVersion;
        }
    }

    private static volatile State state = State.STOPPED;
    private static volatile String failure = null;
    private static volatile Update pending = null;

    static State state() { return state; }
    static String failure() { return failure; }

    /** Stop the server, swap in the update, and start the server again. */
    static void applyUpdate(Context context, Update update) {
        pending = update;
        // Before the old server stops: the activity waits for the new one, not for the old one to answer again.
        state = State.UPDATING;
        context.startForegroundService(new Intent(context, PiService.class).setAction(ACTION_UPDATE));
    }

    private PowerManager.WakeLock wakeLock;
    private Thread runner;
    private Thread notifier;
    /** Screenshots for Pi (Renderer.java). */
    private Thread renderer;
    /** Pi's browser (PiBrowser.java). */
    private Thread browser;
    private volatile Process server;

    @Override
    public IBinder onBind(Intent intent) { return null; }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        startForeground(1, notification());
        if (runner == null) {
            acquireWakeLock();
            runner = new Thread(this::run, "pi-server");
            runner.start();
            notifier = new Thread(this::notifyLoop, "pi-notify");
            notifier.start();
            Renderer render = new Renderer(this, () -> {
                try {
                    return ownerToken(this);
                } catch (Exception e) {
                    throw new IllegalStateException("no owner token: " + e, e);
                }
            }, () -> state == State.RUNNING || state == State.STARTING);
            renderer = new Thread(render::loop, "pi-render");
            renderer.start();
            PiBrowser pages = new PiBrowser(this, () -> {
                try {
                    return ownerToken(this);
                } catch (Exception e) {
                    throw new IllegalStateException("no owner token: " + e, e);
                }
            }, () -> state == State.RUNNING || state == State.STARTING);
            browser = new Thread(pages::loop, "pi-browser");
            browser.start();
        } else if (intent != null && ACTION_UPDATE.equals(intent.getAction())) {
            // The runner swaps the update in once the server has stopped.
            Process running = server;
            if (running != null) running.destroy();
        }
        return START_STICKY;
    }

    static File logFile(File files) { return new File(files, "log/server.log"); }

    private void run() {
        File files = getFilesDir();
        File log = logFile(files);
        try {
            if (!log.getParentFile().isDirectory() && !log.getParentFile().mkdirs()) {
                throw new IOException("cannot create " + log.getParentFile());
            }
            if (RuntimeInstaller.needsBundled(this)) {
                state = State.INSTALLING;
                RuntimeInstaller.installBundled(this, log);
            }
            while (true) {
                swapInPending(log);
                state = State.STARTING;
                server = start(files, log);
                int code = server.waitFor();
                server = null;
                if (pending == null && code != RESTART_CODE) {
                    throw new IOException("server exited with code " + code + "; see " + log);
                }
            }
        } catch (InterruptedException e) {
            state = State.STOPPED;
        } catch (Exception e) {
            Log.e(TAG, "runtime failed", e);
            failure = e.toString();
            state = State.FAILED;
        }
    }

    private void swapInPending(File log) throws Exception {
        Update update = pending;
        if (update == null) return;
        state = State.UPDATING;
        if (update.rootfs != null) swap(RuntimeInstaller.Part.ROOTFS, update.rootfs, update.rootfsVersion, log);
        if (update.runtime != null) swap(RuntimeInstaller.Part.RUNTIME, update.runtime, update.runtimeVersion, log);
        pending = null;
    }

    private void swap(RuntimeInstaller.Part part, File archive, String version, File log) throws Exception {
        try (InputStream in = new FileInputStream(archive)) {
            RuntimeInstaller.install(this, part, in, version, log);
        }
        if (!archive.delete()) throw new IOException("cannot remove " + archive);
    }

    private Process start(File files, File log) throws IOException {
        File prefix = new File(files, "usr");
        File home = new File(files, "home");
        ProcessBuilder builder = new ProcessBuilder(
                new File(prefix, "bin/node").getAbsolutePath(),
                new File(files, "runtime/src/server/main.ts").getAbsolutePath(),
                "--host", "127.0.0.1",
                "--port", String.valueOf(PORT),
                "--cwd", new File(home, "work").getAbsolutePath());
        Map<String, String> env = builder.environment();
        env.put("HOME", home.getAbsolutePath());
        env.put("PREFIX", prefix.getAbsolutePath());
        env.put("TMPDIR", new File(files, "tmp").getAbsolutePath());
        env.put("PATH", prefix.getAbsolutePath() + "/bin:/system/bin");
        // termux-exec (in the rootfs, its prefix rewritten to ours) maps /usr/bin and /bin in exec() to the prefix, so
        // scripts starting with `#!/usr/bin/env node` (every npm CLI, `npm run`) run, as they do in Termux.
        env.put("LD_PRELOAD", new File(prefix, "lib/libtermux-exec-ld-preload.so").getAbsolutePath());
        env.put("LANG", "en_US.UTF-8");
        env.put("TERM", "xterm-256color");
        // This service starts the server again when it exits with 75: the menu's Restart server works (`main.ts`).
        env.put("PI_POCKET_SUPERVISED", "1");
        // The login shell of terminals on the phone (pi-env's daemon starts `SHELL`; places.ts).
        env.put("SHELL", new File(prefix, "bin/bash").getAbsolutePath());
        builder.directory(home);
        builder.redirectErrorStream(true);
        builder.redirectOutput(ProcessBuilder.Redirect.appendTo(log));
        return builder.start();
    }

    /** The owner's sign-in, from the server's config: the activity signs in with it, this service polls with it. */
    static String ownerToken(Context context) throws Exception {
        File config = new File(context.getFilesDir(), "home/.pi-pocket/config.json");
        try (InputStream in = new FileInputStream(config)) {
            return new JSONObject(readAll(in)).getString("ownerToken");
        }
    }

    static String readAll(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int read;
        while ((read = in.read(buffer)) >= 0) out.write(buffer, 0, read);
        return out.toString("UTF-8");
    }

    /**
     * The server's events for the owner (`GET /api/phone/events`, a long poll), as notifications while the app is not
     * in front. It starts at the server's present (`after=-1`), and again after a restart, which starts the sequence
     * anew; a poll that fails (the server restarting) is tried again shortly.
     */
    private void notifyLoop() {
        long after = -1;
        while (!Thread.currentThread().isInterrupted()) {
            try {
                if (state != State.RUNNING && state != State.STARTING) {
                    after = -1;
                    Thread.sleep(2000);
                    continue;
                }
                HttpURLConnection connection = (HttpURLConnection) new URL(
                        "http://127.0.0.1:" + PORT + "/api/phone/events?after=" + after).openConnection();
                connection.setConnectTimeout(3000);
                connection.setReadTimeout(70_000);
                connection.setRequestProperty("Authorization", "Bearer " + ownerToken(this));
                if (connection.getResponseCode() != 200) throw new IOException("HTTP " + connection.getResponseCode());
                JSONObject answer;
                try (InputStream in = connection.getInputStream()) {
                    answer = new JSONObject(readAll(in));
                }
                long seq = answer.getLong("seq");
                // A server that started again counts from 0: start at its present.
                if (seq < after) {
                    after = -1;
                    continue;
                }
                JSONArray events = answer.getJSONArray("events");
                for (int index = 0; index < events.length(); index++) {
                    JSONObject event = events.getJSONObject(index);
                    // About the owner's sign-in (a recovery code was used): shown even with the app in front.
                    if (!MainActivity.inFront || "security".equals(event.getString("kind"))) post(event);
                }
                after = seq;
            } catch (InterruptedException e) {
                return;
            } catch (Exception e) {
                Log.w(TAG, "notifications: " + e);
                try {
                    Thread.sleep(3000);
                } catch (InterruptedException stopped) {
                    return;
                }
            }
        }
    }

    private void post(JSONObject event) throws Exception {
        NotificationManager manager = getSystemService(NotificationManager.class);
        manager.createNotificationChannel(
                new NotificationChannel(EVENTS_CHANNEL, "Sessions", NotificationManager.IMPORTANCE_DEFAULT));
        int session = event.getInt("session");
        String kind = event.getString("kind");
        String title = event.getString("title");
        boolean security = "security".equals(kind);
        String what = security ? "" : "approval".equals(kind) ? "Waiting for you: " : "failed".equals(kind) ? "Failed: " : "Done: ";
        // A security notice opens the app, not a session.
        Intent target = new Intent(this, MainActivity.class);
        if (!security) target.putExtra(EXTRA_SESSION, session);
        PendingIntent open = PendingIntent.getActivity(this, session, target,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification notification = new Notification.Builder(this, EVENTS_CHANNEL)
                .setContentTitle(what + title)
                .setContentText(event.getString("text"))
                .setStyle(new Notification.BigTextStyle().bigText(event.getString("text")))
                .setSmallIcon(R.drawable.ic_notification)
                .setContentIntent(open)
                .setAutoCancel(true)
                .build();
        // One per session: its newest says where it is. Security notices each their own.
        manager.notify(security ? (int) (System.currentTimeMillis() & 0x3fffffff) : 1000 + session, notification);
    }

    /** Marks the server running once the activity has seen it answer. */
    static void markRunning() {
        if (state == State.STARTING) state = State.RUNNING;
    }

    private Notification notification() {
        NotificationManager manager = getSystemService(NotificationManager.class);
        manager.createNotificationChannel(
                new NotificationChannel(CHANNEL, "pi runtime", NotificationManager.IMPORTANCE_LOW));
        PendingIntent open = PendingIntent.getActivity(
                this, 0, new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Builder(this, CHANNEL)
                .setContentTitle("pi")
                .setContentText("agent runtime running")
                .setSmallIcon(R.drawable.ic_notification)
                .setContentIntent(open)
                .setOngoing(true)
                .build();
    }

    private void acquireWakeLock() {
        PowerManager power = (PowerManager) getSystemService(POWER_SERVICE);
        wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "piphone:runtime");
        wakeLock.acquire();
    }

    @Override
    public void onDestroy() {
        Process running = server;
        if (running != null) running.destroy();
        if (runner != null) runner.interrupt();
        if (notifier != null) notifier.interrupt();
        if (renderer != null) renderer.interrupt();
        if (browser != null) browser.interrupt();
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        super.onDestroy();
    }
}
