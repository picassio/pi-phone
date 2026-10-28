package io.piphone;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Person;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.drawable.Icon;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.media.AudioAttributes;
import android.media.AudioDeviceInfo;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.view.KeyEvent;

import java.util.List;
import java.util.function.Consumer;

/**
 * A voice call with Pi going on (PP-185, PP-191): a foreground service while the page's call runs, so the microphone
 * and the voice keep going with the screen off or another app in front. It shows a call-like notification (Android's
 * ongoing-call style from Android 12) with Mute and End, which go to the page that holds the call (`page`, set by the
 * window whose WebView has it), and holds the audio as a call does: focus (music pauses), communication mode (the
 * phone's echo cancelling), and the route: a Bluetooth or wired headset when one is connected, else the speaker. All is
 * given back when the call ends. The page says when a call starts, changes (muted) and ends (`web/voice-call.js`
 * through the bridge's `voiceCall`). No audio goes through here: the WebView has the call.
 *
 * The mic's other switches (PP-201), as Settings › Voice says with each start and update (`muteKey`, `proximity`):
 * - a headset's button (Bluetooth or wired: HEADSETHOOK, PLAY_PAUSE, PLAY, PAUSE) through a media session that is
 *   active only during the call, told to the page as "mic" (it turns the mic off or on);
 * - the volume keys while the app's window or the side-key sheet is in front (`volumeKeys`, their own key handling);
 * - the proximity sensor: the phone is at the ear when the sensor is near (closer than its own range, at most 5 cm) and
 *   the phone does not lie face down (the accelerometer's z above -7 m/s²). Away for 0.5 s is told as "away", at the
 *   ear for 0.3 s as "ear" (the page mutes, and unmutes only what the sensor muted). A phone without the sensor is told
 *   "no-proximity".
 */
public final class VoiceCallService extends Service {

    static final String ACTION_START = "io.piphone.VOICE_START";
    static final String ACTION_UPDATE = "io.piphone.VOICE_UPDATE";
    static final String ACTION_STOP = "io.piphone.VOICE_STOP";
    /** The notification's buttons: to the page. */
    static final String ACTION_MUTE = "io.piphone.VOICE_MUTE";
    static final String ACTION_END = "io.piphone.VOICE_END";
    static final String EXTRA_TITLE = "title";
    static final String EXTRA_SESSION = "session";
    static final String EXTRA_MUTED = "muted";
    static final String EXTRA_MUTE_KEY = "muteKey";
    static final String EXTRA_PROXIMITY = "proximity";
    /** At the ear: the proximity sensor reads nearer than this (cm), or its own range when that is smaller. */
    private static final float NEAR_CM = 5f;
    /** Face down: the accelerometer's z (m/s², toward the screen) below this. */
    private static final float FACE_DOWN = -7f;
    private static final long AWAY_MS = 500;
    private static final long EAR_MS = 300;
    private static final String CHANNEL = "pi-voice";
    private static final int ID = 3;

    /** The page that holds the call: told "mute" or "end" from the notification. Set by the window showing it. */
    static volatile Consumer<String> page;
    private static volatile boolean running;
    /** Settings › Voice's mute key for the call going on: off, headset, volume, or both. */
    private static volatile String muteKey = "off";

    private AudioManager audio;
    private AudioFocusRequest focus;
    private boolean scoStarted;
    private String title = "";
    private int session = -1;
    private boolean muted;
    private long startedAt;
    private MediaSession media;
    private SensorManager sensors;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private boolean nearNow;
    private boolean faceDown;
    /** What the page was last told of the ear: null before the first word. */
    private Boolean toldEar;
    private boolean ear;
    /** A word on the ear waits for its time (`sayEar`). */
    private boolean waiting;
    /** The page was told the phone has no proximity sensor (once a call). */
    private boolean noSensorTold;
    private final Runnable sayEar = () -> {
        waiting = false;
        if (toldEar == null || toldEar != ear) {
            toldEar = ear;
            toPage(ear ? "ear" : "away");
        }
    };
    private final SensorEventListener sensing = new SensorEventListener() {
        @Override
        public void onSensorChanged(SensorEvent event) {
            if (event.sensor.getType() == Sensor.TYPE_PROXIMITY) {
                nearNow = event.values[0] < Math.min(NEAR_CM, event.sensor.getMaximumRange());
            } else if (event.sensor.getType() == Sensor.TYPE_ACCELEROMETER) {
                faceDown = event.values[2] < FACE_DOWN;
            }
            boolean now = nearNow && !faceDown;
            // The same as told, or as already waits: nothing new (a steady stream of the same keeps its time).
            if (now == ear && (waiting || toldEar != null)) return;
            ear = now;
            waiting = true;
            handler.removeCallbacks(sayEar);
            handler.postDelayed(sayEar, now ? EAR_MS : AWAY_MS);
        }

        @Override
        public void onAccuracyChanged(Sensor sensor, int accuracy) {}
    };

    /** A call goes on now. */
    static boolean running() {
        return running;
    }

    /** The volume keys turn the mic off and on now: a call goes on, and Settings › Voice says so. */
    static boolean volumeKeys() {
        return running && ("volume".equals(muteKey) || "both".equals(muteKey));
    }

    /**
     * A volume key in the app's window or the side-key sheet: during a call whose mute key is the volume keys, a press
     * turns the mic off or on (told as "mic") and the key does not change the volume. True when it was taken.
     */
    static boolean volumeKey(int code, KeyEvent event) {
        if (!volumeKeys() || (code != KeyEvent.KEYCODE_VOLUME_UP && code != KeyEvent.KEYCODE_VOLUME_DOWN)) return false;
        if (event.getAction() == KeyEvent.ACTION_DOWN && event.getRepeatCount() == 0) toPage("mic");
        return true;
    }

    /** A word for the page that holds the call ("mic", "ear", "away", "no-proximity", or a button's). */
    static void toPage(String word) {
        Consumer<String> to = page;
        if (to != null) to.accept(word);
    }

    /** The page ended its call: no keys or sensor to follow. */
    static void tell(Context context, String action, String title, int session, boolean muted) {
        tell(context, action, title, session, muted, "off", false);
    }

    /** The page started a call, changed it, or ended it; with it, the mute key and the proximity rule it follows. */
    static void tell(Context context, String action, String title, int session, boolean muted, String muteKey, boolean proximity) {
        if (ACTION_STOP.equals(action)) {
            if (running) context.startService(new Intent(context, VoiceCallService.class).setAction(ACTION_STOP));
            return;
        }
        Intent intent = new Intent(context, VoiceCallService.class)
                .setAction(action)
                .putExtra(EXTRA_TITLE, title)
                .putExtra(EXTRA_SESSION, session)
                .putExtra(EXTRA_MUTED, muted)
                .putExtra(EXTRA_MUTE_KEY, muteKey)
                .putExtra(EXTRA_PROXIMITY, proximity);
        context.startForegroundService(intent);
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? ACTION_STOP : intent.getAction();
        if (ACTION_MUTE.equals(action) || ACTION_END.equals(action)) {
            Consumer<String> to = page;
            if (to != null) to.accept(ACTION_MUTE.equals(action) ? "mute" : "end");
            // The page answers with an update (muted) or a stop (ended); with no page, the call is gone.
            if (to == null) finish();
            return START_NOT_STICKY;
        }
        if (ACTION_STOP.equals(action)) {
            finish();
            return START_NOT_STICKY;
        }
        title = intent.getStringExtra(EXTRA_TITLE) == null ? "" : intent.getStringExtra(EXTRA_TITLE);
        session = intent.getIntExtra(EXTRA_SESSION, -1);
        muted = intent.getBooleanExtra(EXTRA_MUTED, false);
        String key = intent.getStringExtra(EXTRA_MUTE_KEY);
        muteKey = key == null ? "off" : key;
        if (!running) {
            running = true;
            startedAt = System.currentTimeMillis();
            holdAudio();
        }
        headsetButton("headset".equals(muteKey) || "both".equals(muteKey));
        proximity(intent.getBooleanExtra(EXTRA_PROXIMITY, false));
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            startForeground(ID, notification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
        } else {
            startForeground(ID, notification());
        }
        return START_NOT_STICKY;
    }

    private PendingIntent action(String action, int code) {
        return PendingIntent.getService(this, code, new Intent(this, VoiceCallService.class).setAction(action),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private Notification notification() {
        NotificationManager manager = getSystemService(NotificationManager.class);
        manager.createNotificationChannel(
                new NotificationChannel(CHANNEL, getString(R.string.channel_voice), NotificationManager.IMPORTANCE_LOW));
        Intent target = new Intent(this, MainActivity.class).putExtra(MainActivity.EXTRA_VOICE_SHOW, session);
        PendingIntent open = PendingIntent.getActivity(this, 40, target, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        PendingIntent end = action(ACTION_END, 41);
        PendingIntent mute = action(ACTION_MUTE, 42);
        String text = muted ? getString(R.string.voice_muted) : getString(R.string.voice_on_call);
        Notification.Builder builder = new Notification.Builder(this, CHANNEL)
                .setContentTitle(title.isEmpty() ? getString(R.string.voice_title) : getString(R.string.voice_title_session, title))
                .setContentText(text)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentIntent(open)
                .setOngoing(true)
                .setCategory(Notification.CATEGORY_CALL)
                .setUsesChronometer(true)
                .setWhen(startedAt)
                .setShowWhen(true);
        Icon icon = Icon.createWithResource(this, R.drawable.ic_notification);
        Notification.Action muteAction = new Notification.Action.Builder(icon, getString(muted ? R.string.voice_unmute : R.string.voice_mute), mute).build();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            Person pi = new Person.Builder().setName(getString(R.string.voice_caller)).setImportant(true).build();
            builder.setStyle(Notification.CallStyle.forOngoingCall(pi, end)).addAction(muteAction);
        } else {
            builder.addAction(muteAction)
                    .addAction(new Notification.Action.Builder(icon, getString(R.string.voice_end), end).build());
        }
        return builder.build();
    }

    /** Hold the audio as a call: focus, communication mode, and the headset if one is connected, else the speaker. */
    @SuppressWarnings("deprecation")
    private void holdAudio() {
        audio = getSystemService(AudioManager.class);
        AudioAttributes attributes = new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build();
        focus = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
                .setAudioAttributes(attributes)
                .setOnAudioFocusChangeListener(change -> {})
                .build();
        audio.requestAudioFocus(focus);
        audio.setMode(AudioManager.MODE_IN_COMMUNICATION);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            List<AudioDeviceInfo> devices = audio.getAvailableCommunicationDevices();
            AudioDeviceInfo chosen = pick(devices, AudioDeviceInfo.TYPE_BLE_HEADSET);
            if (chosen == null) chosen = pick(devices, AudioDeviceInfo.TYPE_BLUETOOTH_SCO);
            if (chosen == null) chosen = pick(devices, AudioDeviceInfo.TYPE_WIRED_HEADSET);
            if (chosen == null) chosen = pick(devices, AudioDeviceInfo.TYPE_USB_HEADSET);
            if (chosen == null) chosen = pick(devices, AudioDeviceInfo.TYPE_BUILTIN_SPEAKER);
            if (chosen != null) audio.setCommunicationDevice(chosen);
        } else if (headset(AudioDeviceInfo.TYPE_BLUETOOTH_SCO) && audio.isBluetoothScoAvailableOffCall()) {
            audio.startBluetoothSco();
            audio.setBluetoothScoOn(true);
            scoStarted = true;
        } else if (!headset(AudioDeviceInfo.TYPE_WIRED_HEADSET) && !headset(AudioDeviceInfo.TYPE_USB_HEADSET)) {
            audio.setSpeakerphoneOn(true);
        }
    }

    /** A media session while the call runs, so a headset's button comes here and not to a music app: told as "mic". */
    @SuppressWarnings("deprecation")
    private void headsetButton(boolean on) {
        if (on && media == null) {
            media = new MediaSession(this, "pi-voice");
            media.setCallback(new MediaSession.Callback() {
                @Override
                public boolean onMediaButtonEvent(Intent intent) {
                    KeyEvent key = intent.getParcelableExtra(Intent.EXTRA_KEY_EVENT);
                    if (key == null) return false;
                    int code = key.getKeyCode();
                    if (code != KeyEvent.KEYCODE_HEADSETHOOK && code != KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE
                            && code != KeyEvent.KEYCODE_MEDIA_PLAY && code != KeyEvent.KEYCODE_MEDIA_PAUSE) return false;
                    if (key.getAction() == KeyEvent.ACTION_DOWN && key.getRepeatCount() == 0) toPage("mic");
                    return true;
                }
            });
            media.setFlags(MediaSession.FLAG_HANDLES_MEDIA_BUTTONS | MediaSession.FLAG_HANDLES_TRANSPORT_CONTROLS);
            // Playing: Android gives the media buttons to the session that plays.
            media.setPlaybackState(new PlaybackState.Builder()
                    .setActions(PlaybackState.ACTION_PLAY_PAUSE | PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE)
                    .setState(PlaybackState.STATE_PLAYING, PlaybackState.PLAYBACK_POSITION_UNKNOWN, 1f)
                    .build());
            media.setActive(true);
        } else if (!on && media != null) {
            media.setActive(false);
            media.release();
            media = null;
        }
    }

    /** Follow the proximity sensor and the accelerometer (the rule is at the top), or stop. */
    private void proximity(boolean on) {
        if (on && sensors == null) {
            SensorManager manager = getSystemService(SensorManager.class);
            Sensor near = manager == null ? null : manager.getDefaultSensor(Sensor.TYPE_PROXIMITY);
            if (near == null) {
                if (!noSensorTold) toPage("no-proximity");
                noSensorTold = true;
                return;
            }
            sensors = manager;
            toldEar = null;
            ear = false;
            waiting = false;
            nearNow = false;
            faceDown = false;
            sensors.registerListener(sensing, near, SensorManager.SENSOR_DELAY_NORMAL);
            Sensor tilt = sensors.getDefaultSensor(Sensor.TYPE_ACCELEROMETER);
            if (tilt != null) sensors.registerListener(sensing, tilt, SensorManager.SENSOR_DELAY_NORMAL);
        } else if (!on && sensors != null) {
            sensors.unregisterListener(sensing);
            sensors = null;
            waiting = false;
            handler.removeCallbacks(sayEar);
        }
    }

    private static AudioDeviceInfo pick(List<AudioDeviceInfo> devices, int type) {
        for (AudioDeviceInfo device : devices) {
            if (device.getType() == type) return device;
        }
        return null;
    }

    private boolean headset(int type) {
        for (AudioDeviceInfo device : audio.getDevices(AudioManager.GET_DEVICES_OUTPUTS)) {
            if (device.getType() == type) return true;
        }
        return false;
    }

    /** Give the audio back as it was. */
    @SuppressWarnings("deprecation")
    private void releaseAudio() {
        if (audio == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            audio.clearCommunicationDevice();
        } else {
            if (scoStarted) {
                audio.setBluetoothScoOn(false);
                audio.stopBluetoothSco();
                scoStarted = false;
            }
            audio.setSpeakerphoneOn(false);
        }
        audio.setMode(AudioManager.MODE_NORMAL);
        if (focus != null) audio.abandonAudioFocusRequest(focus);
        focus = null;
        audio = null;
    }

    private void finish() {
        running = false;
        muteKey = "off";
        noSensorTold = false;
        headsetButton(false);
        proximity(false);
        releaseAudio();
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    @Override
    public void onDestroy() {
        running = false;
        muteKey = "off";
        headsetButton(false);
        proximity(false);
        releaseAudio();
        super.onDestroy();
    }
}
