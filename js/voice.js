/* ── De'Osa Voice Assistant · ElevenLabs Conversational AI ── *
 *                                                              *
 *  Set window.VOICE_AGENT_ID before this script loads to      *
 *  provide a page-specific agent ID.                           *
 *                                                              *
 *  Set window.VOICE_CLIENT_TOOLS before this script loads to  *
 *  provide page-specific client tools (e.g. cart actions).    *
 * ──────────────────────────────────────────────────────────── */

(function () {

    const AGENT_ID = window.VOICE_AGENT_ID || 'agent_2901kj45e7cnfszrrjfhfj4qdc8j';

    let _conv         = null;
    let _active       = false;
    let _hasSpoken    = false; /* true once agent produces first audio */
    let _Conversation = null; /* pre-loaded SDK class */

    /* Pre-load the ElevenLabs SDK immediately so it's cached and ready
     * before the user even clicks the button — eliminates CDN latency. */
    import('https://cdn.jsdelivr.net/npm/@elevenlabs/client/+esm')
        .then(function (m) { _Conversation = m.Conversation; })
        .catch(function () { /* falls back to on-demand import in voiceStart */ });

    /* ── Inject CSS ── */
    const _style = document.createElement('style');
    _style.textContent = `
        @keyframes voice-connecting-spin {
            0%   { transform: rotate(0deg);   }
            100% { transform: rotate(360deg); }
        }
        #ai-voice-btn.voice-connecting {
            animation: voice-connecting-spin 1.2s linear infinite, none !important;
        }
        #ai-voice-btn.voice-error {
            border-color: rgba(239,68,68,0.85) !important;
            box-shadow: 0 0 14px 4px rgba(239,68,68,0.35) !important;
        }
    `;
    document.head.appendChild(_style);

    /* ── Phone ring tone (Web Audio API — no audio file needed) ────────
     *  UK-style double-ring pattern: two short bursts then silence.
     *  Plays on loop while connecting, stops the moment the agent speaks.
     */
    var _ringCtx   = null;
    var _ringing   = false;
    var _ringTimer = null;

    function _startRing() {
        if (_ringing) return;
        _ringing = true;
        try {
            _ringCtx = new (window.AudioContext || window.webkitAudioContext)();
            _scheduleRingCycle();
        } catch (e) { /* AudioContext not available — silent fallback */ }
    }

    function _scheduleRingCycle() {
        if (!_ringing || !_ringCtx) return;

        var ctx = _ringCtx;
        var t   = ctx.currentTime;

        /* Two sine-wave bursts mixed at 400 Hz + 450 Hz (UK phone ring) */
        [400, 450].forEach(function (freq) {
            var osc  = ctx.createOscillator();
            var gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.type = 'sine';
            osc.frequency.value = freq;

            gain.gain.setValueAtTime(0, t);
            /* Burst 1: 0.0 – 0.4 s */
            gain.gain.linearRampToValueAtTime(0.18, t + 0.02);
            gain.gain.setValueAtTime(0.18, t + 0.38);
            gain.gain.linearRampToValueAtTime(0, t + 0.40);
            /* Burst 2: 0.6 – 1.0 s */
            gain.gain.linearRampToValueAtTime(0.18, t + 0.62);
            gain.gain.setValueAtTime(0.18, t + 0.98);
            gain.gain.linearRampToValueAtTime(0, t + 1.00);

            osc.start(t);
            osc.stop(t + 1.0);
        });

        /* Repeat every 3 s (1 s sound + 2 s silence) */
        _ringTimer = setTimeout(_scheduleRingCycle, 3000);
    }

    function _stopRing() {
        _ringing = false;
        clearTimeout(_ringTimer);
        if (_ringCtx) {
            try { _ringCtx.close(); } catch (e) {}
            _ringCtx = null;
        }
    }

    /* ── UI state machine ── */
    function setVoiceUI(state) {
        const btn      = document.getElementById('ai-voice-btn');
        const idleIcon = document.getElementById('ai-idle-icon');
        const liveIcon = document.getElementById('ai-live-icon');
        if (!btn) return;

        btn.classList.remove('ai-live-glow', 'voice-connecting', 'voice-error');
        btn.style.opacity = '1';

        if (idleIcon) idleIcon.classList.remove('hidden');
        if (liveIcon) { liveIcon.classList.add('hidden'); liveIcon.classList.remove('flex'); }

        switch (state) {
            case 'connecting':
                /* Ring starts here and keeps going until the agent speaks */
                _hasSpoken = false;
                _startRing();
                btn.style.opacity = '0.6';
                btn.classList.add('voice-connecting');
                if (idleIcon) idleIcon.classList.add('hidden');
                if (liveIcon) { liveIcon.classList.remove('hidden'); liveIcon.classList.add('flex'); }
                break;

            case 'listening':
                /* WebSocket is connected but agent hasn't spoken yet —
                 * keep the ring going so the user hears something. */
                btn.classList.add('ai-live-glow');
                if (idleIcon) idleIcon.classList.add('hidden');
                if (liveIcon) { liveIcon.classList.remove('hidden'); liveIcon.classList.add('flex'); }
                break;

            case 'speaking':
                /* Agent's voice starts — stop ring on first speech only */
                if (!_hasSpoken) {
                    _hasSpoken = true;
                    _stopRing();
                }
                btn.classList.add('ai-live-glow');
                if (idleIcon) idleIcon.classList.add('hidden');
                if (liveIcon) { liveIcon.classList.remove('hidden'); liveIcon.classList.add('flex'); }
                break;

            case 'error':
                _stopRing();
                btn.classList.add('voice-error');
                break;

            default: /* idle */
                _stopRing();
                break;
        }
    }

    /* ── Current UK greeting word ── */
    function _ukGreeting() {
        var now    = new Date();
        var ukTime = new Date(now.toLocaleString('en-GB', { timeZone: 'Europe/London' }));
        var hour   = ukTime.getHours();
        return hour >= 5  && hour < 12 ? 'Good morning' :
               hour >= 12 && hour < 18 ? 'Good afternoon' : 'Good evening';
    }

    /* ── Start a session ── */
    async function voiceStart() {
        if (_active) return;
        setVoiceUI('connecting');
        try {
            const Conversation = _Conversation || (await import(
                'https://cdn.jsdelivr.net/npm/@elevenlabs/client/+esm'
            )).Conversation;

            const pageTools = window.VOICE_CLIENT_TOOLS || {};

            /* get_current_time — returns UK time + greeting word */
            if (!pageTools.get_current_time) {
                pageTools.get_current_time = function () {
                    var now    = new Date();
                    var ukTime = new Date(now.toLocaleString('en-GB', { timeZone: 'Europe/London' }));
                    var hour   = ukTime.getHours();
                    var mins   = String(ukTime.getMinutes()).padStart(2, '0');
                    var greeting =
                        hour >= 5  && hour < 12 ? 'Good morning' :
                        hour >= 12 && hour < 18 ? 'Good afternoon' : 'Good evening';
                    return JSON.stringify({ time: hour + ':' + mins, greeting: greeting });
                };
            }

            /* navigate_to_menu — soft-nav with auto-reconnect on arrival */
            if (!pageTools.navigate_to_menu) {
                pageTools.navigate_to_menu = function () {
                    var onMenu = window.location.pathname.toLowerCase().includes('catering');
                    if (onMenu) return "You're already on our menu page — feel free to browse!";
                    sessionStorage.setItem('deosa_voice_return', '1');
                    setTimeout(function () { window.location.href = 'catering.html'; }, 2600);
                    return "I'm taking you to our menu page right now — I'll be right with you there.";
                };
            }

            _conv = await Conversation.startSession({
                agentId: AGENT_ID,
                clientTools: pageTools,

                /* {{greeting}} is replaced in the ElevenLabs First message field.
                 * Set First message to:
                 *   {{greeting}}, this is Mary from De'Osa Catering and Events,
                 *   how can I help you today?                                    */
                dynamicVariables: {
                    greeting: _ukGreeting()
                },

                onConnect: function () {
                    _active = true;
                    setVoiceUI('listening');
                },

                onDisconnect: function () {
                    if (_active) voiceCleanup();
                },

                onError: function (msg) {
                    console.error('[De\'Osa Voice]', msg);
                    _conv   = null;
                    _active = false;
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
            _conv   = null;
            _active = false;
            setVoiceUI('error');
            setTimeout(function () { setVoiceUI('idle'); }, 3000);
        }
    }

    /* ── End a session (user-initiated) ── */
    async function voiceStop() {
        _active = false;
        var conv = _conv;
        _conv = null;
        if (conv) {
            try { await conv.endSession(); } catch (_) { /* ignore */ }
        }
        setVoiceUI('idle');
    }

    /* ── Clean up after server-initiated disconnect ── */
    function voiceCleanup() {
        _active = false;
        _conv   = null;
        setVoiceUI('idle');
    }

    /* ── Public toggle ── */
    window.toggleAIVoice = async function () {
        var onCatering = window.location.pathname.toLowerCase().includes('catering');
        if (!onCatering) {
            sessionStorage.setItem('deosa_voice_autostart', '1');
            window.location.href = 'catering.html';
            return;
        }
        if (_active) { voiceStop(); } else { voiceStart(); }
    };

    /* ── Helper: fire fn after page fully loads ── */
    function afterLoad(delay, fn) {
        if (document.readyState === 'complete') {
            setTimeout(fn, delay);
        } else {
            window.addEventListener('load', function () {
                setTimeout(fn, delay);
            }, { once: true });
        }
    }

    /* ── Auto-start: Instant Quote button on another page ── */
    if (sessionStorage.getItem('deosa_voice_autostart') === '1') {
        sessionStorage.removeItem('deosa_voice_autostart');
        afterLoad(600, voiceStart);
    }

    /* ── Auto-reconnect: assistant navigated user here ── */
    if (sessionStorage.getItem('deosa_voice_return') === '1') {
        sessionStorage.removeItem('deosa_voice_return');
        afterLoad(600, voiceStart);
    }

})();
