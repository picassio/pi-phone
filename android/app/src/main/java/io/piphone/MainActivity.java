package io.piphone;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.text.Html;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.RandomAccessFile;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * Starts PiService, shows its progress, and once the server answers, signs in with the owner token from
 * home/.pi-pocket/config.json and shows the web app (DESIGN.md section 2).
 */
public final class MainActivity extends Activity {

    private static final int FILE_CHOOSER = 1;
    private static final String BASE = "http://127.0.0.1:" + PiService.PORT;

    private WebView web;
    private ValueCallback<Uri[]> pendingFiles;
    private volatile boolean loaded = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        web = new WebView(this);
        web.setBackgroundColor(0xff1a1b26);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMediaPlaybackRequiresUserGesture(false);
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, android.webkit.WebResourceRequest request) {
                Uri url = request.getUrl();
                if (BASE.equals(url.getScheme() + "://" + url.getAuthority())) return false;
                startActivity(new Intent(Intent.ACTION_VIEW, url));
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (pendingFiles != null) pendingFiles.onReceiveValue(null);
                pendingFiles = callback;
                Intent intent = params.createIntent();
                intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
                startActivityForResult(intent, FILE_CHOOSER);
                return true;
            }
        });
        setContentView(web);
        status("Starting…", null);

        startForegroundService(new Intent(this, PiService.class));
        new Thread(this::waitForServer, "pi-wait").start();
    }

    private void waitForServer() {
        PiService.State last = null;
        while (!loaded) {
            PiService.State state = PiService.state();
            if (state == PiService.State.FAILED) {
                failure("The runtime failed", PiService.failure() + "\n\n" + logTail());
                return;
            }
            if (state != last) {
                last = state;
                if (state == PiService.State.INSTALLING) status("Unpacking the runtime…", "First start after an install or update; this takes a minute.");
                if (state == PiService.State.STARTING) status("Starting the server…", null);
            }
            if ((state == PiService.State.STARTING || state == PiService.State.RUNNING) && answers()) {
                PiService.markRunning();
                try {
                    String url = BASE + "/login?token=" + Uri.encode(ownerToken());
                    loaded = true;
                    runOnUiThread(() -> web.loadUrl(url));
                } catch (Exception e) {
                    failure("Cannot sign in", e + "\n\n" + logTail());
                }
                return;
            }
            try {
                Thread.sleep(500);
            } catch (InterruptedException e) {
                return;
            }
        }
    }

    /** The server answers once the app is open; before that it says 503 ("starting"). */
    private static boolean answers() {
        try {
            HttpURLConnection connection = (HttpURLConnection) new URL(BASE + "/").openConnection();
            connection.setConnectTimeout(1000);
            connection.setReadTimeout(2000);
            connection.setInstanceFollowRedirects(false);
            int code = connection.getResponseCode();
            connection.disconnect();
            return code != 503;
        } catch (IOException e) {
            return false;
        }
    }

    private String ownerToken() throws Exception {
        File config = new File(getFilesDir(), "home/.pi-pocket/config.json");
        try (InputStream in = new FileInputStream(config)) {
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int read;
            while ((read = in.read(buffer)) >= 0) out.write(buffer, 0, read);
            return new JSONObject(out.toString("UTF-8")).getString("ownerToken");
        }
    }

    private String logTail() {
        File log = PiService.logFile(getFilesDir());
        try (RandomAccessFile file = new RandomAccessFile(log, "r")) {
            long start = Math.max(0, file.length() - 6000);
            byte[] bytes = new byte[(int) (file.length() - start)];
            file.seek(start);
            file.readFully(bytes);
            return new String(bytes, StandardCharsets.UTF_8);
        } catch (IOException e) {
            return "(no log: " + e + ")";
        }
    }

    /** The web app's colors (web/style.css, the pocket theme): this page shows before the server and its fonts are up. */
    private static final String STATUS_STYLE = "body{margin:0;padding:24px;background:#1a1b26;color:#a9b1d6;"
            + "font:15px/1.5 system-ui,sans-serif}h3{color:#c0caf5;font-weight:600;margin:0 0 12px}"
            + "p{margin:0;color:#a9b1d6}pre{white-space:pre-wrap;font:12px/1.45 monospace;background:#13141c;"
            + "color:#c0caf5;border-radius:8px;padding:12px;margin-top:16px}";

    /** Progress: a title and an optional note. */
    private void status(String title, String note) {
        page(title, note == null ? "" : "<p>" + Html.escapeHtml(note) + "</p>");
    }

    /** A failure: a title and what the log says. */
    private void failure(String title, String log) {
        page(title, "<pre>" + Html.escapeHtml(log) + "</pre>");
    }

    private void page(String title, String body) {
        String html = "<html><head><meta name='viewport' content='width=device-width,initial-scale=1'>"
                + "<style>" + STATUS_STYLE + "</style></head><body>"
                + "<h3>" + Html.escapeHtml(title) + "</h3>" + body + "</body></html>";
        runOnUiThread(() -> web.loadDataWithBaseURL(null, html, "text/html", "utf-8", null));
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode != FILE_CHOOSER || pendingFiles == null) {
            super.onActivityResult(requestCode, resultCode, data);
            return;
        }
        pendingFiles.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
        pendingFiles = null;
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else moveTaskToBack(true);
    }
}
