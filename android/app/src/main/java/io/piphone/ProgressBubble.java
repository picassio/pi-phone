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
import android.os.SystemClock;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
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
    private static final int BLUE = 0xFF7AA2F7;
    /**
     * When the owner last looked at what Pi did: the board opened, or pi-phone in use. A session that ended after it
     * counts on the bubble's blue chip (PP-287); runs that ended before the service started are old news.
     */
    private static volatile long lastLook = System.currentTimeMillis();

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
    /** Something finished since the owner last looked (PP-287). */
    private final TextView dot;
    private long lastEnded;
    /** When each session done in the last day ended, as the board last said. */
    private long[] ends = new long[0];
    private WebView board;
    private WindowManager.LayoutParams boardParams;
    private boolean added;
    /** How long the board stays after a tap opened the app, while Android decides on the start. */
    private static final long FOLD_AFTER_MS = 800;
    /** The bubble on screen now, told at once when pi-phone comes to the front or goes (MainActivity). */
    private static volatile ProgressBubble current;
    /** The app was just opened from the board: it is see-through until it folds, and the circle comes back hidden. */
    private boolean leaving;
    /** A voice call runs on the board's page (PP-290): folding draws its pill instead, and the bubble stays. */
    private boolean calling;
    /** A second tap within this long is a double tap: a voice call (PP-290). A single tap opens the board after it. */
    private static final long DOUBLE_TAP_MS = 250;
    private long lastTap;
    private final Runnable openLater = this::open;
    /** pi-phone in front: the bubble steps aside (the app shows the same), and an open board folds. */
    private final Runnable watchFront = new Runnable() {
        @Override
        public void run() {
            applyFront();
            main.postDelayed(this, 700);
        }
    };

    /** pi-phone in use (its window has the focus, not only shown beside another app): the board folds, the bubble steps aside. */
    private void applyFront() {
        boolean using = MainActivity.inFront && MainActivity.focused;
        if (using) looked();
        if (board != null && using) fold();
        if (added) orb.setVisibility(using ? View.GONE : View.VISIBLE);
    }

    /**
     * pi-phone came to the front or went (its window's focus): the bubble and the board follow at once, not on the next
     * look (PP-285: after Open pi-phone they stayed over the app a moment too long).
     */
    static void frontChanged() {
        ProgressBubble bubble = current;
        if (bubble != null) bubble.main.post(bubble::applyFront);
    }

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
        current = this;
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
        // How many finished since the owner last looked (PP-287): a chip as the others, its number inside (the owner).
        dot = chip(BLUE, BG);
        dot.setVisibility(View.GONE);
        orb.addView(dot, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, dp(18), Gravity.TOP | Gravity.START));

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
                            long now = SystemClock.uptimeMillis();
                            if (now - lastTap < DOUBLE_TAP_MS) {
                                // A double tap: a voice call with Pi (PP-290).
                                main.removeCallbacks(openLater);
                                lastTap = 0;
                                open(true);
                            } else {
                                lastTap = now;
                                main.postDelayed(openLater, DOUBLE_TAP_MS);
                            }
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
    void show(int working, int waiting, long[] ended) {
        ends = ended;
        lastEnded = 0;
        for (long each : ended) lastEnded = Math.max(lastEnded, each);
        unseen();
        ring.turning(working > 0);
        count.setText(String.valueOf(working));
        count.setVisibility(working > 0 ? View.VISIBLE : View.GONE);
        badge.setText(String.valueOf(waiting));
        badge.setVisibility(waiting > 0 ? View.VISIBLE : View.GONE);
        if (!added && board == null) {
            windows.addView(orb, orbParams);
            added = true;
            main.removeCallbacks(watchFront);
            main.post(watchFront);
        }
    }

    /** How many of these sessions ended after the owner last looked. */
    static int unseenOf(long[] ended) {
        int fresh = 0;
        for (long each : ended) if (each > lastLook) fresh++;
        return fresh;
    }

    /** The owner looked: what finished so far is seen, and the bubble's blue chip goes. */
    private void looked() {
        lastLook = Math.max(System.currentTimeMillis(), lastEnded);
        unseen();
    }

    /** The blue chip: how many sessions ended since the owner last looked; none, no chip. */
    private void unseen() {
        int fresh = unseenOf(ends);
        dot.setText(String.valueOf(fresh));
        dot.setVisibility(fresh > 0 ? View.VISIBLE : View.GONE);
    }

    /** A voice call runs on the board (PP-290): the bubble stays while it does, whatever runs. */
    boolean calling() {
        return calling;
    }

    /** The board over the app in front, as wide as the screen; the circle steps aside while it shows. */
    private void open() {
        open(false);
    }

    /**
     * The board, or with `call` a voice call from the bubble (PP-290, a double tap): the page starts it in the session
     * Menu › Assistant names, as a call pill.
     */
    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    private void open(boolean call) {
        if (board != null) return;
        looked();
        board = new WebView(context);
        board.setBackgroundColor(Color.TRANSPARENT);
        WebSettings settings = board.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        board.addJavascriptInterface(new Bridge(), "PiBoard");
        // The microphone for a call (PP-290): the app's own page, audio only, once pi has it.
        board.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                if (VoicePage.ownAudio(request) && micAllowed()) {
                    request.grant(new String[] {PermissionRequest.RESOURCE_AUDIO_CAPTURE});
                } else {
                    request.deny();
                }
            }
        });
        DisplayMetrics screen = context.getResources().getDisplayMetrics();
        WindowManager.LayoutParams params = new WindowManager.LayoutParams(
                screen.widthPixels - dp(20), Math.round(screen.heightPixels * 0.55f),
                WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH,
                PixelFormat.TRANSLUCENT);
        params.gravity = Gravity.TOP | Gravity.CENTER_HORIZONTAL;
        params.y = Math.max(dp(80), orbParams.y - dp(60));
        boardParams = params;
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
                String url = BASE + "/login?token=" + Uri.encode(token.get()) + "&next=" + Uri.encode(call ? "/?board=1&call=1" : "/?board=1");
                main.post(() -> {
                    if (board != null) board.loadUrl(url);
                });
            } catch (Exception e) {
                android.util.Log.w("pi-phone", "board: " + e);
            }
        }, "pi-board-open").start();
    }

    /**
     * A session or a decision's form on the board (PP-283, PP-284): the window grows a little and takes the keyboard while it
     * shows; back to the board's size after.
     */
    private void expand(boolean on) {
        size(on ? 0.62f : 0.55f, on);
    }

    /**
     * The panel's height, a share of the screen, and whether it takes the keyboard. Voice (PP-290) is taller: the app's
     * voice view with its controls did not fit the board's size, and the owner could not scroll to End.
     */
    private void size(float share, boolean keyboard) {
        if (board == null || boardParams == null) return;
        DisplayMetrics screen = context.getResources().getDisplayMetrics();
        // A floating panel, never the whole screen (the owner): a little taller for a session, a form or Voice, the
        // app under it still showing.
        boardParams.height = Math.round(screen.heightPixels * share);
        boardParams.y = Math.max(dp(80), Math.min(orbParams.y - dp(60), screen.heightPixels - boardParams.height - dp(80)));
        if (keyboard) {
            boardParams.flags &= ~WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE;
        } else {
            boardParams.flags |= WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE;
        }
        windows.updateViewLayout(board, boardParams);
    }

    /**
     * The call pill (PP-290): the window as tall as the page says (CSS pixels), across the screen, taking no keyboard;
     * touches beside it go to the app under it.
     */
    private void pill(int cssHeight) {
        if (board == null || boardParams == null) return;
        DisplayMetrics screen = context.getResources().getDisplayMetrics();
        boardParams.height = Math.round(cssHeight * screen.density);
        boardParams.y = Math.max(dp(80), Math.min(orbParams.y, screen.heightPixels - boardParams.height - dp(80)));
        boardParams.flags |= WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE;
        windows.updateViewLayout(board, boardParams);
    }

    private boolean micAllowed() {
        return context.checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) == android.content.pm.PackageManager.PERMISSION_GRANTED;
    }

    /**
     * Android lets pi use the microphone from behind another app only as the phone's digital assistant (a foreground
     * service that needs the microphone, started from the background, is allowed for the app that provides the
     * VoiceInteractionService): the call over other apps needs it.
     */
    private boolean assistantHeld() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return false;
        android.app.role.RoleManager roles = context.getSystemService(android.app.role.RoleManager.class);
        return roles != null && roles.isRoleHeld(android.app.role.RoleManager.ROLE_ASSISTANT);
    }

    /** The board folds back to the circle; with a call on it, to the call's pill (the page draws it and sizes the window). */
    private void fold() {
        if (board == null) return;
        if (calling) {
            board.evaluateJavascript("globalThis.__piBoardFold && globalThis.__piBoardFold()", null);
            return;
        }
        windows.removeView(board);
        board.destroy();
        board = null;
        // Back from opening the app: the circle comes back hidden, and shows on the next look if the app did not come.
        orb.setVisibility(leaving ? View.GONE : View.VISIBLE);
        leaving = false;
        windows.addView(orb, orbParams);
        added = true;
    }

    /**
     * The app is being opened from the board: the board goes see-through and lets touches through at once, while its
     * window stays for Android's check of the start; it folds when the app has the focus, or after FOLD_AFTER_MS.
     */
    private void stepAside() {
        if (board == null) return;
        leaving = true;
        board.setAlpha(0f);
        boardParams.flags |= WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE | WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE;
        windows.updateViewLayout(board, boardParams);
    }

    /** The circle and its board go (turned off, Android's permission taken back, or nothing runs). */
    void remove() {
        if (current == this) current = null;
        if (calling) {
            calling = false;
            VoiceCallService.page = null;
            VoiceCallService.tell(context, VoiceCallService.ACTION_STOP, "", -1, false);
        }
        main.removeCallbacks(watchFront);
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
                // Android weighs the start after it is sent, by the windows pi shows then: the board's window stays a
                // moment, see-through.
                stepAside();
                main.postDelayed(ProgressBubble.this::fold, FOLD_AFTER_MS);
            });
        }

        @JavascriptInterface
        public void openApp() {
            main.post(() -> {
                launch(new Intent(context, MainActivity.class), 3001);
                stepAside();
                main.postDelayed(ProgressBubble.this::fold, FOLD_AFTER_MS);
            });
        }

        @JavascriptInterface
        public void fold() {
            main.post(ProgressBubble.this::fold);
        }

        @JavascriptInterface
        public void expand(boolean on) {
            main.post(() -> ProgressBubble.this.expand(on));
        }

        /** Voice in the panel (PP-290): taller than the board, without the keyboard. */
        @JavascriptInterface
        public void voice() {
            main.post(() -> ProgressBubble.this.size(0.75f, false));
        }

        /** The call pill's height in CSS pixels (PP-290): the window fits it. */
        @JavascriptInterface
        public void pill(int cssHeight) {
            main.post(() -> ProgressBubble.this.pill(cssHeight));
        }

        @JavascriptInterface
        public boolean micAllowed() {
            return ProgressBubble.this.micAllowed();
        }

        /** Whether pi is the phone's digital assistant: a call over other apps needs it (`assistantHeld`). */
        @JavascriptInterface
        public boolean assistantHeld() {
            return ProgressBubble.this.assistantHeld();
        }

        /** Android's Default apps, to make pi the digital assistant; the board folds. */
        @JavascriptInterface
        public void openAssistantSettings() {
            main.post(() -> {
                launch(new Intent(android.provider.Settings.ACTION_MANAGE_DEFAULT_APPS_SETTINGS), 3002);
                stepAside();
                main.postDelayed(ProgressBubble.this::fold, FOLD_AFTER_MS);
            });
        }

        /**
         * A call is about to start in `session` (PP-290): the call's service first, so the microphone is pi's from
         * behind another app before the page asks for it.
         */
        @JavascriptInterface
        public void callStarting(int session, String title) {
            main.post(() -> {
                try {
                    calling = true;
                    VoiceCallService.tell(context, VoiceCallService.ACTION_START, title, session, true);
                } catch (RuntimeException e) {
                    android.util.Log.w("pi-phone", "board: the call's service did not start: " + e);
                }
            });
        }

        /** The board's call started, changed, or ended (`web/voice-call.js`): its notification and audio follow. */
        @JavascriptInterface
        public void voiceCall(String json) {
            main.post(() -> {
                try {
                    String state = VoicePage.tell(context, json);
                    if ("start".equals(state)) {
                        calling = true;
                        VoiceCallService.page = (action) -> main.post(() -> {
                            if (board != null) board.evaluateJavascript(VoicePage.action(action), null);
                        });
                    } else if ("end".equals(state)) {
                        calling = false;
                        VoiceCallService.page = null;
                    }
                } catch (org.json.JSONException e) {
                    android.util.Log.w("pi-phone", "board: voice call: " + e);
                }
            });
        }
    }
}
