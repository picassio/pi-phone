package io.piphone;

import android.accessibilityservice.AccessibilityService;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.graphics.Typeface;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.view.accessibility.AccessibilityEvent;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * pi-phone's accessibility service (PP-141): what lets Pi read other apps' screens and act in them, for
 * PhoneControl.java. It is off until the owner turns it on in Android's Accessibility settings, and it does nothing by
 * itself: PhoneControl asks it, in a control session the owner approved. It also shows the session's banner, "Pi is
 * using your phone" with Stop, as an accessibility overlay over every app.
 *
 * Its shape is ported from lycorp-jp/sim-use's bridge (Apache-2.0, Copyright 2026 LY Corporation),
 * SimuseAccessibilityService.kt: a static instance the rest of the app reaches it by; nothing reacts to events.
 */
public final class PiAccessibility extends AccessibilityService {

    private static volatile PiAccessibility instance;

    /** The service while Android has it connected; null while it is off. */
    static PiAccessibility get() { return instance; }

    private final Handler main = new Handler(Looper.getMainLooper());
    /** The banner and its text (main thread). */
    private LinearLayout banner;
    private TextView bannerText;
    private long bannerUntil;
    private Runnable bannerStop;
    /** Where the banner is on the screen, for PhoneControl to refuse a tap on it; null without one. */
    private volatile Rect bannerRect;
    private final Runnable tick = this::updateBanner;

    @Override
    protected void onServiceConnected() {
        super.onServiceConnected();
        instance = this;
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        // Nothing: the screen is read when Pi asks.
    }

    @Override
    public void onInterrupt() {
    }

    @Override
    public boolean onUnbind(Intent intent) {
        instance = null;
        main.post(this::hideBanner);
        return super.onUnbind(intent);
    }

    @Override
    public void onDestroy() {
        instance = null;
        hideBanner();
        super.onDestroy();
    }

    /** The banner's place on the screen, or null. */
    Rect bannerRect() { return bannerRect; }

    /**
     * Show the banner until `until` (epoch ms), or change the one shown; Stop takes it down and runs `stop` (main thread).
     * It sits over the status bar, so it covers as little of the app as it can.
     */
    void showBanner(long until, Runnable stop) {
        bannerUntil = until;
        bannerStop = stop;
        if (banner == null) {
            float density = getResources().getDisplayMetrics().density;
            int pad = Math.round(8 * density);
            int statusBar = 0;
            int id = getResources().getIdentifier("status_bar_height", "dimen", "android");
            if (id > 0) statusBar = getResources().getDimensionPixelSize(id);
            int height = Math.max(statusBar, Math.round(28 * density));

            LinearLayout box = new LinearLayout(this);
            box.setOrientation(LinearLayout.HORIZONTAL);
            box.setGravity(Gravity.CENTER_VERTICAL);
            box.setBackgroundColor(0xF0B3261E);
            box.setPadding(pad * 2, 0, pad, 0);

            TextView text = new TextView(this);
            text.setTextColor(Color.WHITE);
            text.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
            text.setSingleLine(true);
            box.addView(text, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

            TextView button = new TextView(this);
            button.setText(R.string.phone_control_stop);
            button.setTextColor(Color.WHITE);
            button.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
            button.setTypeface(Typeface.DEFAULT_BOLD);
            button.setGravity(Gravity.CENTER);
            button.setPadding(pad * 2, 0, pad * 2, 0);
            button.setBackgroundColor(0x40FFFFFF);
            button.setOnClickListener((View view) -> {
                Runnable then = bannerStop;
                hideBanner();
                if (then != null) then.run();
            });
            box.addView(button, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.MATCH_PARENT));

            WindowManager.LayoutParams params = new WindowManager.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    height,
                    WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
                    WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                            | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                            | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
                    PixelFormat.TRANSLUCENT);
            params.gravity = Gravity.TOP | Gravity.START;
            params.x = 0;
            params.y = 0;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                params.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            }
            box.addOnLayoutChangeListener((View view, int left, int top, int right, int bottom, int oldLeft, int oldTop, int oldRight, int oldBottom) -> {
                int[] at = new int[2];
                view.getLocationOnScreen(at);
                bannerRect = new Rect(at[0], at[1], at[0] + view.getWidth(), at[1] + view.getHeight());
            });
            getSystemService(WindowManager.class).addView(box, params);
            banner = box;
            bannerText = text;
        }
        updateBanner();
    }

    /** The minutes left on the banner, every 15 seconds; at its end it goes by itself (main thread). */
    private void updateBanner() {
        main.removeCallbacks(tick);
        if (banner == null) return;
        long left = bannerUntil - System.currentTimeMillis();
        if (left <= 0) {
            hideBanner();
            return;
        }
        int minutes = (int) Math.max(1, (left + 59_999) / 60_000);
        bannerText.setText(getString(R.string.phone_control_banner, minutes));
        main.postDelayed(tick, 15_000);
    }

    /** Take the banner down, if it is up (main thread). */
    void hideBanner() {
        main.removeCallbacks(tick);
        bannerRect = null;
        if (banner == null) return;
        try {
            getSystemService(WindowManager.class).removeView(banner);
        } catch (IllegalArgumentException alreadyGone) {
            // The window went with the service.
        }
        banner = null;
        bannerText = null;
    }
}
