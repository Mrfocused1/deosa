/* ── De'Osa Voice Assistant · ElevenLabs Conversational AI ── *
 *                                                              *
 *  Set window.VOICE_AGENT_ID before this script loads to      *
 *  provide a page-specific agent ID.                           *
 *                                                              *
 *  Set window.VOICE_CLIENT_TOOLS before this script loads to  *
 *  provide page-specific client tools (e.g. cart actions).    *
 * ──────────────────────────────────────────────────────────── */

(function () {

    const AGENT_ID  = window.VOICE_AGENT_ID || 'agent_2901kj45e7cnfszrrjfhfj4qdc8j';

    /* ── State ──────────────────────────────────────────────────────────
     *  _connecting: true from button-press until onConnect fires.
     *              Prevents a double-start during the 2.5 s ring window.
     *  _active:    true once the session is live.
     *  _navTimer:  pending navigate_to_menu timeout — cleared on stop.
     */
    let _conv       = null;
    let _active     = false;
    let _connecting = false;
    let _navTimer   = null;

    /* ── CSS ── */
    const _style = document.createElement('style');
    _style.textContent = `
        @keyframes voice-connecting-spin {
            0%   { transform: rotate(0deg);   }
            100% { transform: rotate(360deg); }
        }
        #ai-voice-btn.voice-connecting {
            animation: voice-connecting-spin 1.2s linear infinite,
                       none !important;
        }
        #ai-voice-btn.voice-error {
            border-color: rgba(239,68,68,0.85) !important;
            box-shadow: 0 0 14px 4px rgba(239,68,68,0.35) !important;
        }
    `;
    document.head.appendChild(_style);

    /* ── Phone ring — plays exactly twice then resolves ─────────────────
     *  UK-style: two 1-second bursts (400 Hz + 450 Hz) with a 0.4 s gap.
     *  Total: ~2.4 s. Returns a Promise that resolves when both rings end.
     */
    function _ringTwice() {
        return new Promise(function (resolve) {
            var ctx;
            try {
                ctx = new (window.AudioContext || window.webkitAudioContext)();
                /* iOS Safari creates AudioContext in suspended state — must
                 * resume() within the user-gesture call stack to unlock audio. */
                if (ctx.state === 'suspended') { ctx.resume(); }
                var t = ctx.currentTime;

                [400, 450].forEach(function (freq) {
                    var osc  = ctx.createOscillator();
                    var gain = ctx.createGain();
                    osc.connect(gain);
                    gain.connect(ctx.destination);
                    osc.type = 'sine';
                    osc.frequency.value = freq;

                    gain.gain.setValueAtTime(0, t);
                    /* Ring 1 */
                    gain.gain.linearRampToValueAtTime(0.22, t + 0.03);
                    gain.gain.setValueAtTime(0.22, t + 0.97);
                    gain.gain.linearRampToValueAtTime(0, t + 1.0);
                    /* Ring 2 */
                    gain.gain.linearRampToValueAtTime(0.22, t + 1.43);
                    gain.gain.setValueAtTime(0.22, t + 2.37);
                    gain.gain.linearRampToValueAtTime(0, t + 2.4);

                    osc.start(t);
                    osc.stop(t + 2.4);
                });

                setTimeout(function () {
                    try { ctx.close(); } catch (_) {}
                    resolve();
                }, 2500);

            } catch (e) {
                /* AudioContext unavailable — close if partially created */
                if (ctx) { try { ctx.close(); } catch (_) {} }
                resolve();
            }
        });
    }

    /* ── UI state machine ── */
    function setVoiceUI(state) {
        var btn      = document.getElementById('ai-voice-btn');
        var idleIcon = document.getElementById('ai-idle-icon');
        var liveIcon = document.getElementById('ai-live-icon');
        if (!btn) return;

        btn.classList.remove('ai-live-glow', 'voice-connecting', 'voice-error');
        btn.style.opacity = '1';
        if (idleIcon) idleIcon.classList.remove('hidden');
        if (liveIcon) { liveIcon.classList.add('hidden'); liveIcon.classList.remove('flex'); }

        switch (state) {
            case 'connecting':
                btn.style.opacity = '0.6';
                btn.classList.add('voice-connecting');
                if (idleIcon) idleIcon.classList.add('hidden');
                if (liveIcon) { liveIcon.classList.remove('hidden'); liveIcon.classList.add('flex'); }
                break;
            case 'listening':
                btn.classList.add('ai-live-glow');
                if (idleIcon) idleIcon.classList.add('hidden');
                if (liveIcon) { liveIcon.classList.remove('hidden'); liveIcon.classList.add('flex'); }
                break;
            case 'speaking':
                btn.classList.add('ai-live-glow');
                if (idleIcon) idleIcon.classList.add('hidden');
                if (liveIcon) { liveIcon.classList.remove('hidden'); liveIcon.classList.add('flex'); }
                break;
            case 'error':
                btn.classList.add('voice-error');
                break;
            default: break;
        }
    }

    /* ── Start a session ─────────────────────────────────────────────────
     *  1. Guards against double-start (_connecting OR _active).
     *  2. Rings twice (~2.4 s) so it feels like a real phone call.
     *  3. Requests mic permission explicitly (avoids mid-session prompts).
     *  4. Connects via WebRTC for lower latency and better drop resilience.
     *  5. Pins SDK version to avoid silent breaking changes from @latest.
     */
    async function voiceStart() {
        if (_active || _connecting) return;
        _connecting = true;
        setVoiceUI('connecting');

        /* Ring twice — resolves after ~2.4 s */
        await _ringTwice();

        /* Bail if the call was cancelled during the ring */
        if (!_connecting) return;

        try {
            /* Explicit mic permission request before SDK touches it.
             * Tracks are stopped immediately — on iOS Safari, leaving a
             * MediaStream open holds the mic exclusively and blocks the
             * SDK's own WebRTC getUserMedia call from succeeding. */
            const _permStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            _permStream.getTracks().forEach(function (t) { t.stop(); });

            /* Pinned version — never breaks on a silent @latest update */
            const { Conversation } = await import(
                'https://cdn.jsdelivr.net/npm/@elevenlabs/client@0.14.0/+esm'
            );

            /* Merge page-specific tools with universal tools */
            var pageTools = window.VOICE_CLIENT_TOOLS || {};

            /* get_current_time */
            if (!pageTools.get_current_time) {
                pageTools.get_current_time = function () {
                    try {
                        var now    = new Date();
                        var ukTime = new Date(now.toLocaleString('en-GB', { timeZone: 'Europe/London' }));
                        var hour   = ukTime.getHours();
                        var mins   = String(ukTime.getMinutes()).padStart(2, '0');
                        var greeting =
                            hour >= 5  && hour < 12 ? 'Good morning' :
                            hour >= 12 && hour < 18 ? 'Good afternoon' : 'Good evening';
                        return JSON.stringify({ time: hour + ':' + mins, greeting: greeting });
                    } catch (e) {
                        return JSON.stringify({ time: 'unknown', greeting: 'Hello' });
                    }
                };
            }

            /* navigate_to_menu — stores timeout ref so it can be cancelled */
            if (!pageTools.navigate_to_menu) {
                pageTools.navigate_to_menu = function () {
                    try {
                        var onMenu = window.location.pathname.toLowerCase().includes('catering');
                        if (onMenu) return "You're already on our menu page — feel free to browse!";
                        sessionStorage.setItem('deosa_voice_return', '1');
                        _navTimer = setTimeout(function () {
                            window.location.href = 'catering.html';
                        }, 2600);
                        return "I'm taking you to our menu page right now — I'll be right with you there.";
                    } catch (e) {
                        return 'Navigation is not available right now.';
                    }
                };
            }

            /* iOS Safari triggers an "Advanced Privacy" warning for WebRTC
             * because WebRTC exposes the device's local IP address. Using
             * WebSocket on iOS avoids the prompt entirely. Desktop keeps
             * WebRTC for lower latency.                                    */
            var _isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);

            /* Page-specific dynamic variables (e.g. greeting, client_count) */
            var dynVars = window.VOICE_DYNAMIC_VARIABLES || undefined;

            _conv = await Conversation.startSession({
                agentId          : AGENT_ID,
                connectionType   : _isIOS ? 'websocket' : 'webrtc',
                clientTools      : pageTools,
                dynamicVariables : dynVars,

                onConnect: function () {
                    _connecting = false;
                    _active     = true;
                    setVoiceUI('listening');
                },

                /* ── onDisconnect: clean up state only ──────────────────
                 *  DO NOT call endSession() here — the SDK has already
                 *  closed the WebSocket. Calling endSession() on a closed
                 *  socket causes "WebSocket already CLOSING/CLOSED" errors
                 *  (confirmed: github.com/elevenlabs/packages/issues/87).
                 */
                onDisconnect: function () {
                    _conv       = null;
                    _active     = false;
                    _connecting = false;
                    setVoiceUI('idle');
                },

                onError: function (msg) {
                    console.error('[De\'Osa Voice]', msg);
                    _conv       = null;
                    _active     = false;
                    _connecting = false;
                    setVoiceUI('error');
                    setTimeout(function () { setVoiceUI('idle'); }, 3000);
                },

                onModeChange: function (d) {
                    if (!_active) return;
                    setVoiceUI(d.mode === 'speaking' ? 'speaking' : 'listening');
                }
            });

        } catch (err) {
            console.error('[De\'Osa Voice] Failed to start session:', err);
            _conv       = null;
            _active     = false;
            _connecting = false;
            setVoiceUI('error');
            setTimeout(function () { setVoiceUI('idle'); }, 3000);
        }
    }

    /* ── End a session (user-initiated) ── */
    async function voiceStop() {
        _active     = false;
        _connecting = false;

        /* Cancel any pending page navigation from navigate_to_menu */
        if (_navTimer) { clearTimeout(_navTimer); _navTimer = null; }
        /* Also clear the reconnect flag so the destination page won't auto-start */
        sessionStorage.removeItem('deosa_voice_return');

        var conv = _conv;
        _conv = null;
        if (conv) {
            try { await conv.endSession(); } catch (_) { /* ignore */ }
        }
        setVoiceUI('idle');
    }

    /* ── Public toggle ── */
    window.toggleAIVoice = async function () {
        var onCatering = window.location.pathname.toLowerCase().includes('catering');
        /* If a page sets window.VOICE_AGENT_ID it is voice-capable — skip redirect */
        var voiceEnabled = onCatering || !!window.VOICE_AGENT_ID;
        if (!voiceEnabled) {
            sessionStorage.setItem('deosa_voice_return', '1');
            window.location.href = 'catering.html';
            return;
        }
        if (_active || _connecting) { voiceStop(); } else { voiceStart(); }
    };

    /* ── Auto-reconnect after page navigation ── */
    if (sessionStorage.getItem('deosa_voice_return') === '1') {
        sessionStorage.removeItem('deosa_voice_return');
        setTimeout(voiceStart, 700);
    }

})();
