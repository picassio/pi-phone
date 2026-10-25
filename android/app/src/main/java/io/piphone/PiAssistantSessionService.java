package io.piphone;

import android.os.Bundle;
import android.service.voice.VoiceInteractionSession;
import android.service.voice.VoiceInteractionSessionService;

/** Makes the assistant's sessions (PP-146): one sheet each time the side key is held. */
public final class PiAssistantSessionService extends VoiceInteractionSessionService {
    @Override
    public VoiceInteractionSession onNewSession(Bundle args) {
        return new PiAssistantSession(this);
    }
}
