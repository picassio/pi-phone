package io.piphone;

import android.content.Context;
import android.content.pm.PackageManager;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

/**
 * The runtime in the app's files folder (DESIGN.md sections 2 and 5), in two parts:
 * rootfs (files/usr, the Termux prefix) and runtime (files/runtime, the server). Each part has a stamp with its
 * version. The parts bundled in the APK are extracted when the APK changes (a new versionCode); an update downloaded
 * later replaces one part at a time. Extraction goes to a staging folder first and is swapped in, so a failed one
 * leaves the part before it whole. home/ is never touched.
 */
final class RuntimeInstaller {

    enum Part {
        ROOTFS("rootfs", "usr", "usr/bin/node"),
        RUNTIME("runtime", "runtime", "runtime/src/server/main.ts");

        final String name;
        final String dir;
        final String required;

        Part(String name, String dir, String required) {
            this.name = name;
            this.dir = dir;
            this.required = required;
        }
    }

    private static final String APK_STAMP = ".apk-version";

    private RuntimeInstaller() {}

    /** The version of a part, or of the shell, that this APK carries (assets written by scripts/versions.ts). */
    static String bundled(Context context, String name) throws IOException {
        try (InputStream in = context.getAssets().open(name + "-version")) {
            return new String(readAll(in), StandardCharsets.UTF_8).trim();
        }
    }

    /** The version of a part extracted now, or null for none. */
    static String installed(Context context, Part part) throws IOException {
        return readStamp(new File(context.getFilesDir(), "." + part.name + "-version"));
    }

    static long apkVersion(Context context) throws PackageManager.NameNotFoundException {
        return context.getPackageManager().getPackageInfo(context.getPackageName(), 0).getLongVersionCode();
    }

    /** Whether this APK's parts still need extracting: a fresh install, or an APK update. */
    static boolean needsBundled(Context context) throws IOException, PackageManager.NameNotFoundException {
        return !String.valueOf(apkVersion(context)).equals(readStamp(new File(context.getFilesDir(), APK_STAMP)));
    }

    static void installBundled(Context context, File log)
            throws IOException, InterruptedException, PackageManager.NameNotFoundException {
        for (Part part : Part.values()) {
            try (InputStream in = context.getAssets().open(part.name + ".bin")) {
                install(context, part, in, bundled(context, part.name), log);
            }
        }
        for (String dir : new String[] {"home", "home/work", "tmp", "log"}) {
            File each = new File(context.getFilesDir(), dir);
            if (!each.isDirectory() && !each.mkdirs()) throw new IOException("cannot create " + each);
        }
        writeStamp(new File(context.getFilesDir(), APK_STAMP), String.valueOf(apkVersion(context)));
    }

    /** Extracts one part from a gzipped tar and swaps it in. */
    static void install(Context context, Part part, InputStream gzippedTar, String version, File log)
            throws IOException, InterruptedException {
        File files = context.getFilesDir();
        File staging = new File(files, "staging-" + part.name);
        File current = new File(files, part.dir);
        File old = new File(files, part.dir + ".old");

        deleteTree(staging);
        deleteTree(old);
        if (!staging.mkdirs()) throw new IOException("cannot create " + staging);
        extract(gzippedTar, staging, log, part.name);
        if (!new File(staging, part.required).isFile()) {
            throw new IOException(part.name + " incomplete: missing " + part.required);
        }
        if (current.exists() && !current.renameTo(old)) throw new IOException("cannot move " + current + " aside");
        if (!new File(staging, part.dir).renameTo(current)) throw new IOException("cannot move " + part.dir + " in");
        writeStamp(new File(files, "." + part.name + "-version"), version);
        deleteTree(old);
        deleteTree(staging);
    }

    /** Streams a gzipped tar into the system tar. A non-zero exit is an error. */
    private static void extract(InputStream gzippedTar, File into, File log, String what)
            throws IOException, InterruptedException {
        ProcessBuilder builder = new ProcessBuilder("/system/bin/tar", "-xzf", "-", "-C", into.getAbsolutePath());
        builder.redirectErrorStream(true);
        builder.redirectOutput(ProcessBuilder.Redirect.appendTo(log));
        Process tar = builder.start();
        try (OutputStream out = tar.getOutputStream()) {
            byte[] buffer = new byte[256 * 1024];
            int read;
            while ((read = gzippedTar.read(buffer)) >= 0) out.write(buffer, 0, read);
        }
        int code = tar.waitFor();
        if (code != 0) throw new IOException("tar exited " + code + " extracting " + what + "; see " + log);
    }

    private static String readStamp(File stamp) throws IOException {
        if (!stamp.isFile()) return null;
        try (InputStream in = new FileInputStream(stamp)) {
            return new String(readAll(in), StandardCharsets.UTF_8).trim();
        }
    }

    private static void writeStamp(File stamp, String value) throws IOException {
        try (OutputStream out = new FileOutputStream(stamp)) {
            out.write(value.getBytes(StandardCharsets.UTF_8));
        }
    }

    static void deleteTree(File file) throws IOException {
        // Symlinks are removed, not followed.
        boolean link = java.nio.file.Files.isSymbolicLink(file.toPath());
        if (file.isDirectory() && !link) {
            File[] children = file.listFiles();
            if (children != null) for (File child : children) deleteTree(child);
        }
        if ((file.exists() || link) && !file.delete()) throw new IOException("cannot remove " + file);
    }

    static byte[] readAll(InputStream in) throws IOException {
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int read;
        while ((read = in.read(buffer)) >= 0) out.write(buffer, 0, read);
        return out.toByteArray();
    }
}
