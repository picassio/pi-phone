package io.piphone;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

/**
 * Updates from the repository's latest GitHub release (DESIGN.md section 5). Its manifest.json says the shell, rootfs,
 * and runtime versions and where each asset is. A different shell needs the APK; otherwise a different rootfs or
 * runtime is downloaded, checked against its SHA-256, and swapped in by PiService.
 */
final class Updater {

    static final String MANIFEST = "https://github.com/picassio/pi-phone/releases/latest/download/manifest.json";
    static final String INSTALL_STATUS = "io.piphone.INSTALL_STATUS";

    enum Kind { NONE, RUNTIME, APK }

    static final class Plan {
        final Kind kind;
        final JSONObject manifest;
        final boolean rootfs;
        final boolean runtime;

        Plan(Kind kind, JSONObject manifest, boolean rootfs, boolean runtime) {
            this.kind = kind;
            this.manifest = manifest;
            this.rootfs = rootfs;
            this.runtime = runtime;
        }

        String shortVersion() {
            return manifest.optString("runtimeVersion").substring(0, 7);
        }
    }

    private Updater() {}

    static Plan check(Context context) throws Exception {
        JSONObject manifest = new JSONObject(new String(get(MANIFEST), StandardCharsets.UTF_8));
        if (manifest.getLong("versionCode") <= RuntimeInstaller.apkVersion(context)
                && manifest.getString("runtimeVersion").equals(
                        RuntimeInstaller.installed(context, RuntimeInstaller.Part.RUNTIME))) {
            return new Plan(Kind.NONE, manifest, false, false);
        }
        if (!manifest.getString("shellVersion").equals(RuntimeInstaller.bundled(context, "shell"))) {
            // Only a newer build may ask for an APK: an older release (a rollback of the latest tag) is no update.
            boolean newer = manifest.getLong("versionCode") > RuntimeInstaller.apkVersion(context);
            return new Plan(newer ? Kind.APK : Kind.NONE, manifest, false, false);
        }
        boolean rootfs = !manifest.getString("rootfsVersion")
                .equals(RuntimeInstaller.installed(context, RuntimeInstaller.Part.ROOTFS));
        boolean runtime = !manifest.getString("runtimeVersion")
                .equals(RuntimeInstaller.installed(context, RuntimeInstaller.Part.RUNTIME));
        return new Plan(rootfs || runtime ? Kind.RUNTIME : Kind.NONE, manifest, rootfs, runtime);
    }

    interface Progress {
        void at(String what, long done, long total);
    }

    /** Downloads one asset of the manifest into `into`, checking its size and SHA-256. */
    static File download(JSONObject asset, File into, Progress progress) throws Exception {
        if (!into.isDirectory() && !into.mkdirs()) throw new IOException("cannot create " + into);
        String name = asset.getString("name");
        long size = asset.getLong("size");
        File file = new File(into, name);
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        HttpURLConnection connection = open(asset.getString("url"));
        long done = 0;
        try (InputStream in = connection.getInputStream(); OutputStream out = new FileOutputStream(file)) {
            byte[] buffer = new byte[256 * 1024];
            int read;
            while ((read = in.read(buffer)) >= 0) {
                out.write(buffer, 0, read);
                digest.update(buffer, 0, read);
                done += read;
                progress.at(name, done, size);
            }
        } finally {
            connection.disconnect();
        }
        if (done != size) throw new IOException(name + ": got " + done + " bytes, expected " + size);
        String sha = hex(digest.digest());
        if (!sha.equals(asset.getString("sha256"))) {
            throw new IOException(name + ": SHA-256 " + sha + " does not match the manifest");
        }
        return file;
    }

    /** Hands an APK to Android's installer; the system asks the user, and reports to INSTALL_STATUS. */
    static void installApk(Context context, File apk) throws IOException {
        PackageInstaller installer = context.getPackageManager().getPackageInstaller();
        PackageInstaller.SessionParams params =
                new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
        params.setAppPackageName(context.getPackageName());
        int id = installer.createSession(params);
        try (PackageInstaller.Session session = installer.openSession(id)) {
            try (InputStream in = new FileInputStream(apk);
                 OutputStream out = session.openWrite("pi-phone.apk", 0, apk.length())) {
                byte[] buffer = new byte[256 * 1024];
                int read;
                while ((read = in.read(buffer)) >= 0) out.write(buffer, 0, read);
                session.fsync(out);
            }
            Intent status = new Intent(INSTALL_STATUS).setPackage(context.getPackageName());
            PendingIntent pending = PendingIntent.getBroadcast(
                    context, id, status, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_MUTABLE);
            session.commit(pending.getIntentSender());
        }
    }

    private static byte[] get(String url) throws IOException {
        HttpURLConnection connection = open(url);
        try (InputStream in = connection.getInputStream()) {
            return RuntimeInstaller.readAll(in);
        } finally {
            connection.disconnect();
        }
    }

    /** GitHub answers release downloads with redirects to its storage host; all of them are https. */
    private static HttpURLConnection open(String url) throws IOException {
        for (int hops = 0; hops < 5; hops++) {
            HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(15_000);
            connection.setReadTimeout(60_000);
            int code = connection.getResponseCode();
            if (code >= 300 && code < 400) {
                String next = connection.getHeaderField("Location");
                connection.disconnect();
                if (next == null || !next.startsWith("https://")) throw new IOException(url + ": bad redirect " + next);
                url = next;
                continue;
            }
            if (code != 200) {
                connection.disconnect();
                throw new IOException(url + ": HTTP " + code);
            }
            return connection;
        }
        throw new IOException(url + ": too many redirects");
    }

    private static String hex(byte[] bytes) {
        StringBuilder out = new StringBuilder();
        for (byte b : bytes) out.append(String.format("%02x", b));
        return out.toString();
    }

}
