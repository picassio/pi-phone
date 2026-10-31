package io.piphone;

import android.animation.ObjectAnimator;
import android.animation.ValueAnimator;
import android.annotation.SuppressLint;
import android.app.ActivityOptions;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.PixelFormat;
import android.graphics.RectF;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.DisplayMetrics;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.view.animation.LinearInterpolator;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.TextView;

import java.util.function.Supplier;

/**
 * The floating progress board (PP-283, GitHub issue #5): pi's logo in a small dark circle over other apps, a ring that
 * turns around it while Pi works, a count of the sessions at work, and an amber badge when one waits for the owner.
 * Dragged, it goes to the nearest side. A tap opens the board (`/?board=1`, web/board.js) over the app in front: a row
 * opens its session in the app, the dash folds it back to the circle. Shown while the owner has it on and Android lets
 * pi display over other apps (Progress.java decides); it never reads what is under it.
 */
final class ProgressBubble {
    private static final String BASE = "http://127.0.0.1:" + PiService.PORT;
    private static final int BG = 0xFF1A1B26;
    private static final int RING = 0xFF9ECE6A;
    private static final int AMBER = 0xFFE0AF68;

    private final Context context;
    private final Supplier<String> token;
    private final WindowManager windows;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final float density;
    private final FrameLayout orb;
    private final WindowManager.LayoutParams orbParams;
    private final Ring ring;
    private final TextView count;
    private final TextView badge;
    private WebView board;
    private boolean added;

    /** A ring around the logo: a quarter left open, turned while Pi works. */
    private static final class Ring extends View {
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final RectF box = new RectF();
        private final ObjectAnimator spin;

        Ring(Context context, float width) {
            super(context);
            paint.setStyle(Paint.Style.STROKE);
            paint.setStrokeWidth(width);
            paint.setStrokeCap(Paint.Cap.ROUND);
            paint.setColor(RING);
            spin = ObjectAnimator.ofFloat(this, "rotation", 0f, 360f);
            spin.setDuration(2400);
            spin.setRepeatCount(ValueAnimator.INFINITE);
            spin.setInterpolator(new LinearInterpolator());
        }

        void turning(boolean on) {
            setVisibility(on ? VISIBLE : INVISIBLE);
            if (on && !spin.isStarted()) spin.start();
            if (!on) spin.cancel();
        }

        @Override
        protected void onDraw(Canvas canvas) {
            float inset = paint.getStrokeWidth();
            box.set(inset, inset, getWidth() - inset, getHeight() - inset);
            canvas.drawArc(box, 0, 270, false, paint);
        }
    }

    @SuppressLint("ClickableViewAccessibility")
    ProgressBubble(Context context, Supplier<String> token) {
        this.context = context;
        this.token = token;
        this.windows = context.getSystemService(WindowManager.class);
        this.density = context.getResources().getDisplayMetrics().density;

        int size = dp(56);
        orb = new FrameLayout(context);
        GradientDrawable circle = new GradientDrawable();
        circle.setShape(GradientDrawable.OVAL);
        circle.setColor(BG);
        circle.setStroke(dp(1), 0x33A9B1D6);
        orb.setBackground(circle);
        orb.setElevation(dp(8));
        orb.setContentDescription(context.getString(R.string.progress_bubble));

        ring = new Ring(context, dp(2));
        orb.addView(ring, new FrameLayout.LayoutParams(size, size));

        ImageView logo = new ImageView(context);
        logo.setImageResource(R.drawable.pi_mark);
        orb.addView(logo, new FrameLayout.LayoutParams(dp(28), dp(28), Gravity.CENTER));

        count = chip(BG, Color.WHITE);
        orb.addView(count, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, dp(18), Gravity.BOTTOM | Gravity.START));
        badge = chip(AMBER, BG);
        orb.addView(badge, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, dp(18), Gravity.TOP | Gravity.END));

        orbParams = new WindowManager.LayoutParams(size, size,
                WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
                PixelFormat.TRANSLUCENT);
        orbParams.gravity = Gravity.TOP | Gravity.START;
        DisplayMetrics screen = context.getResources().getDisplayMetrics();
        orbParams.x = screen.widthPixels - size - dp(8);
        orbParams.y = screen.heightPixels / 3;

        orb.setOnTouchListener(new View.OnTouchListener() {
            private float downX;
            private float downY;
            private int startX;
            private int startY;
            private boolean moved;

            @Override
            public boolean onTouch(View view, MotionEvent event) {
                switch (event.getActionMasked()) {
                    case MotionEvent.ACTION_DOWN:
                        downX = event.getRawX();
                        downY = event.getRawY();
                        startX = orbParams.x;
                        startY = orbParams.y;
                        moved = false;
                        return true;
                    case MotionEvent.ACTION_MOVE:
                        float dx = event.getRawX() - downX;
                        float dy = event.getRawY() - downY;
                        if (Math.abs(dx) + Math.abs(dy) > dp(8)) moved = true;
                        orbParams.x = startX + (int) dx;
                        orbParams.y = startY + (int) dy;
                        windows.updateViewLayout(orb, orbParams);
                        return true;
                    case MotionEvent.ACTION_UP:
                        if (!moved) {
                            open();
                        } else {
                            // To the nearest side, as chat heads go.
                            int width = context.getResources().getDisplayMetrics().widthPixels;
                            orbParams.x = orbParams.x + size / 2 < width / 2 ? dp(8) : width - size - dp(8);
                            windows.updateViewLayout(orb, orbParams);
                        }
                        return true;
                    default:
                        return false;
                }
            }
        });
    }

    private TextView chip(int background, int text) {
        TextView chip = new TextView(context);
        GradientDrawable pill = new GradientDrawable();
        pill.setCornerRadius(dp(9));
        pill.setColor(background);
        pill.setStroke(dp(1), 0x33A9B1D6);
        chip.setBackground(pill);
        chip.setTextColor(text);
        chip.setTextSize(11);
        chip.setGravity(Gravity.CENTER);
        chip.setMinWidth(dp(18));
        chip.setPadding(dp(4), 0, dp(4), 0);
        chip.setTypeface(chip.getTypeface(), android.graphics.Typeface.BOLD);
        return chip;
    }

    private int dp(float value) {
        return Math.round(value * density);
    }

    /** The circle with its counts: the ring turns while Pi works; the badge shows what waits for the owner. */
    void show(int working, int waiting) {
        ring.turning(working > 0);
        count.setText(String.valueOf(working));
        count.setVisibility(working > 0 ? View.VISIBLE : View.GONE);
        badge.setText(String.valueOf(waiting));
        badge.setVisibility(waiting > 0 ? View.VISIBLE : View.GONE);
        if (!added && board == null) {
            windows.addView(orb, orbParams);
            added = true;
        }
    }

    /** The board over the app in front, as wide as the screen; the circle steps aside while it shows. */
    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    private void open() {
        if (board != null) return;
        board = new WebView(context);
        board.setBackgroundColor(Color.TRANSPARENT);
        WebSettings settings = board.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        board.addJavascriptInterface(new Bridge(), "PiBoard");
        DisplayMetrics screen = context.getResources().getDisplayMetrics();
        WindowManager.LayoutParams params = new WindowManager.LayoutParams(
                screen.widthPixels - dp(20), Math.round(screen.heightPixels * 0.55f),
                WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH,
                PixelFormat.TRANSLUCENT);
        params.gravity = Gravity.TOP | Gravity.CENTER_HORIZONTAL;
        params.y = Math.max(dp(80), orbParams.y - dp(60));
        // A tap outside the board folds it.
        board.setOnTouchListener((view, event) -> {
            if (event.getActionMasked() == MotionEvent.ACTION_OUTSIDE) fold();
            return false;
        });
        if (added) {
            windows.removeView(orb);
            added = false;
        }
        windows.addView(board, params);
        new Thread(() -> {
            try {
                String url = BASE + "/login?token=" + Uri.encode(token.get()) + "&next=" + Uri.encode("/?board=1");
                main.post(() -> {
                    if (board != null) board.loadUrl(url);
                });
            } catch (Exception e) {
                android.util.Log.w("pi-phone", "board: " + e);
            }
        }, "pi-board-open").start();
    }

    /** The board folds back to the circle. */
    private void fold() {
        if (board == null) return;
        windows.removeView(board);
        board.destroy();
        board = null;
        windows.addView(orb, orbParams);
        added = true;
    }

    /** The circle and its board go (turned off, Android's permission taken back, or nothing runs). */
    void remove() {
        if (board != null) {
            windows.removeView(board);
            board.destroy();
            board = null;
        }
        if (added) {
            windows.removeView(orb);
            added = false;
        }
    }

    /**
     * The app, brought to the front from the board: the service is in the background, and Android lets it start an
     * activity only through a PendingIntent that it, as creator and sender, says may start one (Android 14 and later);
     * a plain startActivity from here is dropped without a word (PP-283: a tapped row opened nothing). Sent while the
     * board still shows, then the board folds.
     */
    private void launch(Intent target, int code) {
        target.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        int flags = PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT;
        try {
            if (Build.VERSION.SDK_INT >= 34) {
                ActivityOptions creator = ActivityOptions.makeBasic();
                creator.setPendingIntentCreatorBackgroundActivityStartMode(ActivityOptions.MODE_BACKGROUND_ACTIVITY_START_ALLOWED);
                PendingIntent pending = PendingIntent.getActivity(context, code, target, flags, creator.toBundle());
                ActivityOptions sender = ActivityOptions.makeBasic();
                sender.setPendingIntentBackgroundActivityStartMode(ActivityOptions.MODE_BACKGROUND_ACTIVITY_START_ALLOWED);
                pending.send(context, 0, null, null, null, null, sender.toBundle());
            } else {
                PendingIntent.getActivity(context, code, target, flags).send();
            }
            android.util.Log.i("pi-phone", "board: opened " + target.getIntExtra(PiService.EXTRA_SESSION, -1));
        } catch (Exception e) {
            android.util.Log.w("pi-phone", "board: could not open the app: " + e);
        }
    }

    /** The board's page: open a session or the app, fold. */
    private final class Bridge {
        @JavascriptInterface
        public void open(int session) {
            android.util.Log.i("pi-phone", "board: tapped session " + session);
            main.post(() -> {
                launch(new Intent(context, MainActivity.class).putExtra(PiService.EXTRA_SESSION, session), 3000);
                fold();
            });
        }

        @JavascriptInterface
        public void openApp() {
            main.post(() -> {
                launch(new Intent(context, MainActivity.class), 3001);
                fold();
            });
        }

        @JavascriptInterface
        public void fold() {
            main.post(ProgressBubble.this::fold);
        }
    }
}
