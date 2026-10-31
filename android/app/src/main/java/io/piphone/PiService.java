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
    /** The always-on notification's channel, quiet: the progress board (Progress.java) updates it. */
    static final String RUNTIME_CHANNEL = CHANNEL;
    /** Sessions that finished, failed, or ask for an approval (phone-events.ts), and files saved to Downloads. */
    static final String EVENTS_CHANNEL = "pi-events";
    /** The session a notification opens: MainActivity reads it. */
    static final String EXTRA_SESSION = "io.piphone.SESSION";
    private static final String TAG = "pi-phone";
    private static final String ACTION_UPDATE = "io.piphone.UPDATE";
    /** Stop on the notification of a phone control session (PhoneControl.java). */
    static final String ACTION_PHONE_STOP = "io.piphone.PHONE_STOP";

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
    /** Pi controls this phone (PhoneControl.java). */
    private Thread control;
    private PhoneControl phoneControl;
    /** What Pi does in every session, in the notification and the floating bubble (Progress.java, PP-283). */
    private Thread progressThread;
    private Progress progress;
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
            phoneControl = new PhoneControl(this, () -> {
                try {
                    return ownerToken(this);
                } catch (Exception e) {
                    throw new IllegalStateException("no owner token: " + e, e);
                }
            }, () -> state == State.RUNNING || state == State.STARTING);
            control = new Thread(phoneControl::loop, "pi-phone-control");
            control.start();
            progress = new Progress(this, () -> {
                try {
                    return ownerToken(this);
                } catch (Exception e) {
                    throw new IllegalStateException("no owner token: " + e, e);
                }
            }, () -> state == State.RUNNING || state == State.STARTING, this::notification);
            progressThread = new Thread(progress::loop, "pi-progress");
            progressThread.start();
        } else if (intent != null && Progress.ACTION_APPROVE.equals(intent.getAction())) {
            String id = intent.getStringExtra(Progress.EXTRA_APPROVAL);
            if (id != null && progress != null) progress.approve(id);
        } else if (intent != null && ACTION_PHONE_STOP.equals(intent.getAction())) {
            phoneControl.stopFromPhone();
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
                stopEarlierServer(files, log);
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
                // The phone's language: the server says the events in it when the owner's choice is Auto (PP-85).
                HttpURLConnection connection = (HttpURLConnection) new URL(
                        "http://127.0.0.1:" + PORT + "/api/phone/events?after=" + after
                                + "&lang=" + java.net.URLEncoder.encode(java.util.Locale.getDefault().toLanguageTag(), "UTF-8")).openConnection();
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
                new NotificationChannel(EVENTS_CHANNEL, getString(R.string.channel_sessions), NotificationManager.IMPORTANCE_DEFAULT));
        int session = event.getInt("session");
        String kind = event.getString("kind");
        boolean security = "security".equals(kind);
        // A security notice opens the app, not a session.
        Intent target = new Intent(this, MainActivity.class);
        if (!security) target.putExtra(EXTRA_SESSION, session);
        PendingIntent open = PendingIntent.getActivity(this, session, target,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        // The server says what happened, in the owner's language (`heading`: "Done: <title>", …).
        Notification notification = new Notification.Builder(this, EVENTS_CHANNEL)
                .setContentTitle(event.getString("heading"))
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
                new NotificationChannel(CHANNEL, getString(R.string.channel_runtime), NotificationManager.IMPORTANCE_LOW));
        PendingIntent open = PendingIntent.getActivity(
                this, 0, new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Builder(this, CHANNEL)
                .setContentTitle("pi")
                .setContentText(getString(R.string.runtime_running))
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

    // ─── A server before this one (PP-198) ───

    /**
     * How long a server asked to stop (SIGTERM) may take before it is killed: its own limit is 10 s (`STOP_LIMIT_MS` in
     * main.ts), so a server that keeps it is never killed.
     */
    private static final long STOP_GRACE_MS = 11_000;
    /** The server a destroyed service asked to stop: the next service waits for it (same app process). */
    private static volatile Process stopping;

    /** Ask `running` to stop (SIGTERM), and kill it if it has not after STOP_GRACE_MS; the next start waits for it. */
    private static void end(Process running) {
        stopping = running;
        running.destroy();
        Thread killer = new Thread(() -> {
            try {
                if (!running.waitFor(STOP_GRACE_MS, java.util.concurrent.TimeUnit.MILLISECONDS)) running.destroyForcibly();
            } catch (InterruptedException e) {
                running.destroyForcibly();
            }
        }, "pi-server-end");
        killer.setDaemon(true);
        killer.start();
    }

    /**
     * Before a server starts: no other server of this app may be running on its data. The server a destroyed service
     * stopped is waited for; and a server left running when Android ended the app's process but not its child (some
     * phones do) holds the data's lock (`harness.lock`, its pid): when that pid is this app's node running this
     * runtime's main.ts, it is asked to stop (SIGTERM), and killed (SIGKILL) if it has not after STOP_GRACE_MS. Without
     * this the new server finds the lock held and exits ("server exited with code 1"). A pid that is not ours is never
     * signalled.
     */
    private void stopEarlierServer(File files, File log) throws InterruptedException {
        Process earlier = stopping;
        if (earlier != null) {
            if (!earlier.waitFor(STOP_GRACE_MS + 2_000, java.util.concurrent.TimeUnit.MILLISECONDS)) earlier.destroyForcibly().waitFor(2, java.util.concurrent.TimeUnit.SECONDS);
            stopping = null;
        }
        int pid = lockPid(new File(files, "home/.pi-pocket/harness.lock"));
        if (pid <= 0 || pid == android.os.Process.myPid() || !isOurServer(pid, files)) return;
        note(log, "stopping an earlier pi-phone server left running (pid " + pid + ")");
        android.os.Process.sendSignal(pid, 15);
        if (!gone(pid, files, STOP_GRACE_MS)) {
            android.os.Process.sendSignal(pid, 9);
            gone(pid, files, 3_000);
        }
        note(log, (gone(pid, files, 0) ? "stopped" : "could not stop") + " an earlier pi-phone server left running (pid " + pid + ")");
    }

    /** The pid in a lock file, or 0 when there is none (no lock: no server holds the data). */
    private static int lockPid(File lock) {
        try (InputStream in = new FileInputStream(lock)) {
            return Integer.parseInt(readAll(in).trim());
        } catch (IOException | NumberFormatException e) {
            return 0;
        }
    }

    /** Whether `pid` is a live (not zombie) process of this app running this runtime's server. */
    private static boolean isOurServer(int pid, File files) {
        try {
            String cmdline;
            String status;
            try (InputStream in = new FileInputStream("/proc/" + pid + "/cmdline")) {
                cmdline = readAll(in);
            }
            try (InputStream in = new FileInputStream("/proc/" + pid + "/status")) {
                status = readAll(in);
            }
            return isServer(cmdline, status, new File(files, "usr/bin/node").getAbsolutePath(),
                    new File(files, "runtime/src/server/main.ts").getAbsolutePath(), android.os.Process.myUid());
        } catch (IOException e) {
            return false;
        }
    }

    /**
     * Whether a process's `/proc/<pid>/cmdline` (NUL-separated) and `/proc/<pid>/status` say it is `node` running
     * `main` (as `start` runs it), alive (not a zombie), with the real uid `uid`.
     */
    static boolean isServer(String cmdline, String status, String node, String main, int uid) {
        String[] args = cmdline.split("\0");
        if (args.length < 2 || !args[0].equals(node) || !args[1].equals(main)) return false;
        boolean ours = false;
        for (String line : status.split("\n")) {
            if (line.startsWith("State:") && line.substring(6).trim().startsWith("Z")) return false;
            if (line.startsWith("Uid:")) {
                String[] ids = line.substring(4).trim().split("\\s+");
                ours = ids.length > 0 && ids[0].equals(String.valueOf(uid));
            }
        }
        return ours;
    }

    /** Wait up to `ms` for `pid` to be gone (or no longer our server); whether it is. */
    private static boolean gone(int pid, File files, long ms) throws InterruptedException {
        long until = System.currentTimeMillis() + ms;
        while (true) {
            if (!isOurServer(pid, files)) return true;
            if (System.currentTimeMillis() >= until) return false;
            Thread.sleep(200);
        }
    }

    /** A line of the app's own in server.log, beside the server's. */
    private static void note(File log, String line) {
        try (java.io.FileOutputStream out = new java.io.FileOutputStream(log, true)) {
            out.write(("pi-phone app: " + line + "\n").getBytes(java.nio.charset.StandardCharsets.UTF_8));
        } catch (IOException e) {
            Log.w(TAG, "server.log: " + e);
        }
    }

    @Override
    public void onDestroy() {
        Process running = server;
        // Asked to stop, and killed if it has not in time: never left running without its service.
        if (running != null) end(running);
        if (runner != null) runner.interrupt();
        if (notifier != null) notifier.interrupt();
        if (renderer != null) renderer.interrupt();
        if (browser != null) browser.interrupt();
        if (control != null) control.interrupt();
        if (progressThread != null) progressThread.interrupt();
        if (progress != null) progress.stop();
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        super.onDestroy();
    }
}
