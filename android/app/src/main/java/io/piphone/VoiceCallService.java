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
import android.media.AudioAttributes;
import android.media.AudioDeviceInfo;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.os.Build;
import android.os.IBinder;

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
    private static final String CHANNEL = "pi-voice";
    private static final int ID = 3;

    /** The page that holds the call: told "mute" or "end" from the notification. Set by the window showing it. */
    static volatile Consumer<String> page;
    private static volatile boolean running;

    private AudioManager audio;
    private AudioFocusRequest focus;
    private boolean scoStarted;
    private String title = "";
    private int session = -1;
    private boolean muted;
    private long startedAt;

    /** A call goes on now. */
    static boolean running() {
        return running;
    }

    /** The page started a call, changed it, or ended it. */
    static void tell(Context context, String action, String title, int session, boolean muted) {
        if (ACTION_STOP.equals(action)) {
            if (running) context.startService(new Intent(context, VoiceCallService.class).setAction(ACTION_STOP));
            return;
        }
        Intent intent = new Intent(context, VoiceCallService.class)
                .setAction(action)
                .putExtra(EXTRA_TITLE, title)
                .putExtra(EXTRA_SESSION, session)
                .putExtra(EXTRA_MUTED, muted);
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
        if (!running) {
            running = true;
            startedAt = System.currentTimeMillis();
            holdAudio();
        }
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
        releaseAudio();
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    @Override
    public void onDestroy() {
        running = false;
        releaseAudio();
        super.onDestroy();
    }
}
