package io.piphone;

import android.content.Context;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

/**
 * Extracts the bundled runtime into the app's files folder (DESIGN.md section 2):
 * rootfs.bin -> files/usr (the Termux prefix), runtime.bin -> files/runtime (the server).
 * The runtime-version asset, written by CI, says which build the assets are; files/.runtime-version says which build
 * is extracted. home/ is never touched.
 */
final class RuntimeInstaller {

    private static final String STAMP = ".runtime-version";

    private RuntimeInstaller() {}

    static String bundledVersion(Context context) throws IOException {
        try (InputStream in = context.getAssets().open("runtime-version")) {
            return new String(readAll(in), StandardCharsets.UTF_8).trim();
        }
    }

    static boolean isCurrent(Context context) throws IOException {
        File stamp = new File(context.getFilesDir(), STAMP);
        if (!stamp.isFile()) return false;
        try (InputStream in = new FileInputStream(stamp)) {
            return new String(readAll(in), StandardCharsets.UTF_8).trim().equals(bundledVersion(context));
        }
    }

    static void install(Context context, File log) throws IOException, InterruptedException {
        File files = context.getFilesDir();
        File stamp = new File(files, STAMP);
        if (stamp.exists() && !stamp.delete()) throw new IOException("cannot remove " + stamp);

        deleteTree(new File(files, "usr"));
        deleteTree(new File(files, "runtime"));
        extract(context, "rootfs.bin", files, log);
        extract(context, "runtime.bin", files, log);
        requireFile(new File(files, "usr/bin/node"));
        requireFile(new File(files, "runtime/src/server/main.ts"));

        for (String dir : new String[] {"home", "home/work", "tmp", "log"}) {
            File each = new File(files, dir);
            if (!each.isDirectory() && !each.mkdirs()) throw new IOException("cannot create " + each);
        }

        try (OutputStream out = new FileOutputStream(stamp)) {
            out.write(bundledVersion(context).getBytes(StandardCharsets.UTF_8));
        }
    }

    /** Streams one gzipped tar asset into the system tar. A non-zero exit is an error. */
    private static void extract(Context context, String asset, File into, File log)
            throws IOException, InterruptedException {
        ProcessBuilder builder = new ProcessBuilder("/system/bin/tar", "-xzf", "-", "-C", into.getAbsolutePath());
        builder.redirectErrorStream(true);
        builder.redirectOutput(ProcessBuilder.Redirect.appendTo(log));
        Process tar = builder.start();
        try (InputStream in = context.getAssets().open(asset); OutputStream out = tar.getOutputStream()) {
            byte[] buffer = new byte[256 * 1024];
            int read;
            while ((read = in.read(buffer)) >= 0) out.write(buffer, 0, read);
        }
        int code = tar.waitFor();
        if (code != 0) throw new IOException("tar exited " + code + " extracting " + asset + "; see " + log);
    }

    private static void requireFile(File file) throws IOException {
        if (!file.isFile()) throw new IOException("runtime incomplete: missing " + file);
    }

    private static void deleteTree(File file) throws IOException {
        // Symlinks are removed, not followed.
        if (file.isDirectory() && !isSymlink(file)) {
            File[] children = file.listFiles();
            if (children != null) for (File child : children) deleteTree(child);
        }
        if (file.exists() || isSymlink(file)) {
            if (!file.delete()) throw new IOException("cannot remove " + file);
        }
    }

    private static boolean isSymlink(File file) throws IOException {
        return java.nio.file.Files.isSymbolicLink(file.toPath());
    }

    private static byte[] readAll(InputStream in) throws IOException {
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int read;
        while ((read = in.read(buffer)) >= 0) out.write(buffer, 0, read);
        return out.toByteArray();
    }
}
